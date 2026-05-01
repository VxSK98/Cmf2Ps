# custom_nodes/comfyui-cmf2ps/cmf2ps_nodes.py

import os
import torch
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
        self.prefix_append = "_cmf2ps_"
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

    async def _send_all(self, filenames):
        for filename in filenames:
            await cmf2ps_backend.send_preview_image(filename)
        await cmf2ps_backend.send_preview_done()

    def execute(self, images, filename_prefix="CMF2PS", prompt=None, extra_pnginfo=None):
        result = self.save_images(images, filename_prefix, prompt, extra_pnginfo)
        filenames = [item["filename"] for item in result["ui"]["images"]]
        _fire_and_forget(self._send_all(filenames))
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




class CMF2PS_LoadImage:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "client_id": ("STRING", {"default": "ps"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("изображение", "маска", "ширина", "высота")
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
    RETURN_NAMES = ("изображение", "ширина", "высота")
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
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CMF2PS_SendToPhotoshop": "Отправит в фотошоп (CMF2PS)",
    "CMF2PS_LoadImage": "Загрузка снапшота (CMF2PS)",
    "CMF2PS_LoadRef": "Загрузка рефа (CMF2PS)",
}
