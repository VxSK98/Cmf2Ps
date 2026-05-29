# custom_nodes/comfyui-cmf2ps/cmf2ps_nodes.py

import os
import math
import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image, ImageOps
import asyncio

import folder_paths
from nodes import SaveImage

from . import cmf2ps_backend
from .cmf2ps_backend import _last_image_path, _last_mask_path, _last_ref_path

def _client_image_path(client_id: str) -> str:
    safe_client = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in client_id)
    return os.path.join(folder_paths.get_input_directory(), "_cmf2ps", f"{safe_client}.png")


def _fire_and_forget(coro):
    """
    Безопасный запуск корутины из sync-кода ноды:
    - если event loop уже крутится -> create_task
    - иначе -> asyncio.run
    """
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)
    except RuntimeError:
        asyncio.run(coro)


class CMF2PS_SendToPhotoshop(SaveImage):
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.prefix_append = "_cmf2ps"
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "CMF2PS"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    # ВАЖНО: output-узел — без выходов
    RETURN_TYPES = ()
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "CMF2PS"

    async def _send_all(self, image_items):
        for item in image_items:
            await cmf2ps_backend.send_preview_image(
                item["filename"],
                width=item.get("width"),
                height=item.get("height"),
            )
        await cmf2ps_backend.send_preview_done()

    def execute(self, images, filename_prefix="CMF2PS", prompt=None, extra_pnginfo=None):
        result = self.save_images(images, filename_prefix, prompt, extra_pnginfo)
        saved_images = result["ui"]["images"]
        image_items = []

        for index, item in enumerate(saved_images):
            image_info = {"filename": item["filename"]}

            if index < len(images):
                image = images[index]
                if len(image.shape) >= 2:
                    image_info["height"] = int(image.shape[0])
                    image_info["width"] = int(image.shape[1])

            image_items.append(image_info)

        _fire_and_forget(self._send_all(image_items))
        return result

def _load_rgb_image(path: str):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img).convert("RGB")
    arr = np.asarray(img).astype(np.float32) / 255.0
    tensor = torch.from_numpy(arr)[None, ...]
    return img.size, tensor

def _load_mask_image(path: str, width: int, height: int):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img).convert("L")

    if img.size != (width, height):
        img = img.resize((width, height), Image.Resampling.BILINEAR)

    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)

def _empty_rgb_image(width: int = 8, height: int = 8):
    tensor = torch.zeros((1, height, width, 3), dtype=torch.float32)
    return (width, height), tensor

def _empty_mask(width: int = 8, height: int = 8):
    return torch.zeros((height, width), dtype=torch.float32)


def _parse_radii(value):
    radii = []
    for item in str(value).split(","):
        item = item.strip()
        if not item:
            continue
        try:
            radius = int(item)
        except ValueError:
            continue
        if radius > 0:
            radii.append(radius)
    return radii or [2, 4, 8, 16]


def _gaussian_kernel1d(kernel_size, dtype, device):
    kernel_size = int(kernel_size)
    if kernel_size <= 1:
        return None

    if kernel_size % 2 == 0:
        kernel_size += 1

    sigma = max(kernel_size / 6.0, 1e-6)
    radius = kernel_size // 2
    x = torch.arange(-radius, radius + 1, dtype=dtype, device=device)
    kernel = torch.exp(-(x * x) / (2.0 * sigma * sigma))
    return kernel / kernel.sum()


def _blur_height(height, kernel_size):
    kernel = _gaussian_kernel1d(kernel_size, height.dtype, height.device)
    if kernel is None:
        return height

    b, h, w = height.shape
    pad = kernel.numel() // 2
    x = height[:, None, :, :]
    kx = kernel.view(1, 1, 1, -1)
    ky = kernel.view(1, 1, -1, 1)

    if w > 1:
        x = F.pad(x, (pad, pad, 0, 0), mode="replicate")
        x = F.conv2d(x, kx)
    if h > 1:
        x = F.pad(x, (0, 0, pad, pad), mode="replicate")
        x = F.conv2d(x, ky)

    return x[:, 0, :, :]


def _normalize_height(height):
    flat = height.flatten(1)
    h_min = flat.min(dim=1).values[:, None, None]
    h_max = flat.max(dim=1).values[:, None, None]
    span = h_max - h_min
    return torch.where(span > 1e-8, (height - h_min) / span.clamp_min(1e-8), torch.zeros_like(height))


def _normal_to_height(normal, invert_y=False, post_blur=1):
    normal = normal.clamp(0.0, 1.0).to(dtype=torch.float32)
    x = normal[..., 0] * 2.0 - 1.0
    y = normal[..., 1] * 2.0 - 1.0
    if invert_y:
        y = -y

    dx = -x
    dy = y

    b, h, w = dx.shape
    u = torch.fft.fftfreq(w, device=normal.device, dtype=normal.dtype) * (2.0 * math.pi)
    v = torch.fft.fftfreq(h, device=normal.device, dtype=normal.dtype) * (2.0 * math.pi)
    v_grid, u_grid = torch.meshgrid(v, u)
    denom = u_grid * u_grid + v_grid * v_grid
    denom = denom.clone()
    denom[0, 0] = 1.0

    fx = torch.fft.fft2(dx)
    fy = torch.fft.fft2(dy)
    height_freq = (1j * (u_grid[None, :, :] * fx + v_grid[None, :, :] * fy)) / denom[None, :, :]
    height_freq[:, 0, 0] = 0.0
    height = torch.fft.ifft2(height_freq).real

    kernel_size = int(max(0, post_blur)) | 1
    if kernel_size > 1:
        height = _blur_height(height, kernel_size)

    return -height


def _highpass_enhance(height, radius=16, amount=1.0):
    radius = int(max(0, radius))
    amount = float(amount)
    if radius <= 0 or amount == 0.0:
        return _normalize_height(height)

    kernel_size = (radius * 2) | 1
    low = _blur_height(height, kernel_size)
    high = height - low
    abs_high = high.abs().flatten(1)
    kth = max(1, int((abs_high.shape[1] - 1) * 0.95) + 1)
    scale = abs_high.kthvalue(kth, dim=1).values[:, None, None].clamp_min(1e-8)
    enhanced = low + amount * (high / scale)
    return _normalize_height(enhanced).clamp(0.0, 1.0)


def _shift_sample(height, dy, dx):
    b, h, w = height.shape
    dst_y0 = max(0, -dy)
    dst_y1 = min(h, h - dy)
    dst_x0 = max(0, -dx)
    dst_x1 = min(w, w - dx)

    if dst_y0 >= dst_y1 or dst_x0 >= dst_x1:
        return torch.zeros_like(height), torch.zeros_like(height)

    src_y0 = dst_y0 + dy
    src_y1 = dst_y1 + dy
    src_x0 = dst_x0 + dx
    src_x1 = dst_x1 + dx

    out = torch.zeros_like(height)
    mask = torch.zeros_like(height)
    out[:, dst_y0:dst_y1, dst_x0:dst_x1] = height[:, src_y0:src_y1, src_x0:src_x1]
    mask[:, dst_y0:dst_y1, dst_x0:dst_x1] = 1.0
    return out, mask


def _height_to_ao(
    height,
    radii,
    directions=8,
    bias=0.03,
    intensity=1.0,
    step=1,
    depth_strength=2.5,
    edge_strength=0.35,
    ao_blur=5,
):
    directions = int(max(1, directions))
    step = int(max(1, step))
    bias = float(bias)
    intensity = float(intensity)
    depth_strength = float(max(0.0, depth_strength))
    edge_strength = float(max(0.0, edge_strength))
    max_radius = max(1, max(int(r) for r in radii))

    broad_kernel = (max_radius * 2) | 1
    broad_height = _blur_height(height, broad_kernel)
    depth_occlusion = F.relu(broad_height - height - bias * 0.25)
    depth_occlusion = 1.0 - torch.exp(-depth_occlusion * depth_strength * 5.0)

    angles = torch.linspace(
        0.0,
        2.0 * math.pi,
        directions + 1,
        device=height.device,
        dtype=height.dtype,
    )[:-1]
    horizon_occlusion = torch.zeros_like(height)
    line_count = 0

    for radius in radii:
        radius = int(max(1, radius))
        steps = max(1, radius // step)
        for angle in angles:
            cs = float(torch.cos(angle).item())
            sn = float(torch.sin(angle).item())
            horizon = torch.zeros_like(height)

            for sample_index in range(1, steps + 1):
                distance = sample_index * step
                dx = int(round(cs * distance))
                dy = int(round(sn * distance))
                if dx == 0 and dy == 0:
                    continue

                sample, mask = _shift_sample(height, dy, dx)
                delta = F.relu(sample - height - bias) * mask
                slope = (delta * depth_strength) / math.sqrt(float(distance))
                horizon = torch.max(horizon, slope)

            horizon_occlusion = horizon_occlusion + (horizon / (1.0 + horizon))
            line_count += 1

    if line_count > 0:
        horizon_occlusion = horizon_occlusion / float(line_count)

    horizon_occlusion = 1.0 - torch.exp(-horizon_occlusion * edge_strength * 3.0)
    occlusion = 1.0 - (1.0 - depth_occlusion) * (1.0 - horizon_occlusion)

    ao_blur = int(max(0, ao_blur)) | 1
    if ao_blur > 1:
        occlusion = _blur_height(occlusion, ao_blur)

    return (1.0 - occlusion * intensity).clamp(0.0, 1.0)


def _grayscale_to_image(value):
    value = value.clamp(0.0, 1.0)
    return value[:, :, :, None].repeat(1, 1, 1, 3)


class CMF2PS_NormalToAO:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "normal": ("IMAGE",),
                "radii": ("STRING", {"default": "2,4,8,16"}),
                "directions": ("INT", {"default": 8, "min": 1, "max": 32, "step": 1}),
                "bias": ("FLOAT", {"default": 0.03, "min": 0.0, "max": 0.5, "step": 0.001}),
                "intensity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.05}),
                "depth_strength": ("FLOAT", {"default": 2.5, "min": 0.0, "max": 8.0, "step": 0.05}),
                "edge_strength": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 4.0, "step": 0.05}),
                "ray_step": ("INT", {"default": 1, "min": 1, "max": 16, "step": 1}),
                "ao_blur": ("INT", {"default": 5, "min": 0, "max": 63, "step": 2}),
                "post_blur": ("INT", {"default": 1, "min": 0, "max": 31, "step": 2}),
                "highpass_radius": ("INT", {"default": 16, "min": 0, "max": 128, "step": 1}),
                "highpass_amount": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.05}),
                "invert_y": ("BOOLEAN", {"default": False}),
                "white_occlusion": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("ao", "height")
    FUNCTION = "generate"
    CATEGORY = "CMF2PS"

    def generate(
        self,
        normal,
        radii="2,4,8,16",
        directions=8,
        bias=0.03,
        intensity=1.0,
        depth_strength=2.5,
        edge_strength=0.35,
        ray_step=1,
        ao_blur=5,
        post_blur=1,
        highpass_radius=16,
        highpass_amount=1.0,
        invert_y=False,
        white_occlusion=False,
    ):
        with torch.no_grad():
            height = _normal_to_height(normal, invert_y=invert_y, post_blur=post_blur)
            height = _highpass_enhance(height, radius=highpass_radius, amount=highpass_amount)
            ao = _height_to_ao(
                height,
                radii=_parse_radii(radii),
                directions=directions,
                bias=bias,
                intensity=intensity,
                step=ray_step,
                depth_strength=depth_strength,
                edge_strength=edge_strength,
                ao_blur=ao_blur,
            )

            if white_occlusion:
                ao = 1.0 - ao

            return (_grayscale_to_image(ao), _grayscale_to_image(height))


class CMF2PS_LoadImage:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "client_id": ("STRING", {"default": "ps"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "load"
    CATEGORY = "CMF2PS"

    def load(self, client_id="ps"):
        path = _last_image_path.get(client_id)

        if not path or not os.path.exists(path):
            disk_path = _client_image_path("snapshot")
            if os.path.exists(disk_path):
                path = disk_path
                _last_image_path[client_id] = disk_path

        if not path or not os.path.exists(path):
            w, h = 8, 8
            _, image_tensor = _empty_rgb_image(w, h)
            mask_tensor = _empty_mask(w, h)
            return (image_tensor, mask_tensor, w, h)

        (w, h), image_tensor = _load_rgb_image(path)

        mask_path = _last_mask_path.get(client_id)
        if not mask_path or not os.path.exists(mask_path):
            disk_mask_path = _client_image_path("mask")
            if os.path.exists(disk_mask_path):
                mask_path = disk_mask_path
                _last_mask_path[client_id] = disk_mask_path

        mask_tensor = _load_mask_image(mask_path, w, h)

        w8 = max(8, (w // 8) * 8)
        h8 = max(8, (h // 8) * 8)

        return (image_tensor, mask_tensor, w8, h8)

    @classmethod
    def IS_CHANGED(s, client_id="ps"):
        image_path = _last_image_path.get(client_id)
        if not image_path or not os.path.exists(image_path):
            return "no_image"

        image_st = os.stat(image_path)

        mask_path = _last_mask_path.get(client_id)
        if mask_path and os.path.exists(mask_path):
            mask_st = os.stat(mask_path)
            return f"{image_st.st_mtime_ns}-{image_st.st_size}-{mask_st.st_mtime_ns}-{mask_st.st_size}"

        return f"{image_st.st_mtime_ns}-{image_st.st_size}-no_mask"


class CMF2PS_LoadRef:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "client_id": ("STRING", {"default": "ps"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")
    FUNCTION = "load"
    CATEGORY = "CMF2PS"

    def load(self, client_id="ps"):
        path = _last_ref_path.get(client_id)

        if not path or not os.path.exists(path):
            disk_path = _client_image_path("ref")
            if os.path.exists(disk_path):
                path = disk_path
                _last_ref_path[client_id] = disk_path

        if not path or not os.path.exists(path):
            w, h = 8, 8
            _, tensor = _empty_rgb_image(w, h)
            return (tensor, w, h)

        img = Image.open(path)
        img = ImageOps.exif_transpose(img).convert("RGB")

        w, h = img.size
        w8 = max(8, (w // 8) * 8)
        h8 = max(8, (h // 8) * 8)

        arr = np.asarray(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr)[None, ...]
        return (tensor, w8, h8)

    @classmethod
    def IS_CHANGED(s, client_id="ps"):
        path = _last_ref_path.get(client_id)

        if not path or not os.path.exists(path):
            disk_path = _client_image_path("ref")
            if os.path.exists(disk_path):
                path = disk_path

        if not path or not os.path.exists(path):
            return "no_image"

        st = os.stat(path)
        return f"{st.st_mtime_ns}-{st.st_size}"

NODE_CLASS_MAPPINGS = {
    "CMF2PS_SendToPhotoshop": CMF2PS_SendToPhotoshop,
    "CMF2PS_LoadImage": CMF2PS_LoadImage,
    "CMF2PS_LoadRef": CMF2PS_LoadRef,
    "CMF2PS_NormalToAO": CMF2PS_NormalToAO,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CMF2PS_SendToPhotoshop": "Send to Photoshop",
    "CMF2PS_LoadImage": "Load Snapshot",
    "CMF2PS_LoadRef": "Load Reference",
    "CMF2PS_NormalToAO": "Normal to AO",
}
