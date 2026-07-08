
# Важно: сначала импортируем backend, чтобы он зарегистрировал routes,
# потом nodes, чтобы ноды появились в UI.
from . import cmf2ps_backend  # noqa: F401

from .cmf2ps_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

WEB_DIRECTORY = "js"
