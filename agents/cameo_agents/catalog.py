"""The browser's catalog and audiences (sent in request bodies; the server keeps no project state).

    Audience        {id, name, kind, basedOn?}             ids are free strings ("aud-3f2a"); nothing assumes regions
    CatalogProduct  {id, brand, name, category, url, availableIn: 'all' | AudienceId[], description?}

A product is eligible for an audience when availableIn == 'all', or availableIn lists the audience or any audience it is
basedOn (followed recursively, cycle-safe). `to_products` expands the catalog into one pipeline `Product` per
(product, eligible audience), with `region` = the audience id and `id` = the catalog id unchanged.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, ValidationError

from .schemas import Product

MAX_PRODUCTS = 500
MAX_AUDIENCES = 50


class Audience(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(max_length=120)
    kind: str = Field(max_length=60)
    basedOn: Optional[str] = Field(None, max_length=64)


class CatalogProduct(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    brand: str = Field(max_length=120)
    name: str = Field(max_length=300)
    category: str = Field(max_length=120)
    url: str = Field("", max_length=1000)
    availableIn: Union[Literal["all"], list[str]] = "all"
    description: Optional[str] = Field(None, max_length=1000)


class CatalogError(ValueError):
    pass


def parse_audiences(raw) -> list[Audience]:
    if not isinstance(raw, list) or not raw:
        raise CatalogError("audiences must be a non-empty list of {id, name, kind, basedOn?}")
    if len(raw) > MAX_AUDIENCES:
        raise CatalogError(f"at most {MAX_AUDIENCES} audiences")
    try:
        out = [Audience.model_validate(a) for a in raw]
    except ValidationError as e:
        raise CatalogError(f"bad audience: {e.errors()[0]['loc']} {e.errors()[0]['msg']}") from None
    ids = [a.id for a in out]
    if len(set(ids)) != len(ids):
        raise CatalogError("duplicate audience id")
    return out


def parse_catalog(raw) -> list[CatalogProduct]:
    if not isinstance(raw, list) or not raw:
        raise CatalogError("catalog must be a non-empty list of products")
    if len(raw) > MAX_PRODUCTS:
        raise CatalogError(f"at most {MAX_PRODUCTS} products")
    try:
        out = [CatalogProduct.model_validate(p) for p in raw]
    except ValidationError as e:
        raise CatalogError(f"bad product: {e.errors()[0]['loc']} {e.errors()[0]['msg']}") from None
    ids = [p.id for p in out]
    if len(set(ids)) != len(ids):
        raise CatalogError("duplicate product id")
    return out


def lineage(audience_id: str, audiences: list[Audience]) -> list[str]:
    """The audience and every audience it is basedOn, nearest first (stops at unknown ids and cycles)."""
    by_id = {a.id: a for a in audiences}
    chain, cur = [], audience_id
    while cur is not None and cur not in chain:
        chain.append(cur)
        cur = by_id[cur].basedOn if cur in by_id else None
    return chain


def eligible(p: CatalogProduct, audience_id: str, audiences: list[Audience]) -> bool:
    if p.availableIn == "all":
        return True
    return any(a in p.availableIn for a in lineage(audience_id, audiences))


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "brand"


def to_products(catalog: list[CatalogProduct], audiences: list[Audience]) -> list[Product]:
    out = []
    for a in audiences:
        for p in catalog:
            if eligible(p, a.id, audiences):
                name = f"{p.name} ({p.description})" if p.description else p.name
                out.append(Product(id=p.id, line=_slug(p.brand), region=a.id, brand=p.brand, name=name, category=p.category))
    return out


def audience_lines(audiences: list[Audience]) -> str:
    """For prompts: what each opaque audience id means."""
    return "\n".join(f"- {a.id}: {a.name} ({a.kind}" + (f", based on {a.basedOn}" if a.basedOn else "") + ")" for a in audiences)


def catalog_hash(catalog: list[CatalogProduct], audiences: list[Audience]) -> str:
    """Stable id for a (catalog, audiences) pair: cache keys and match ids."""
    doc = {"c": sorted((p.model_dump() for p in catalog), key=lambda d: d["id"]), "a": sorted((a.model_dump() for a in audiences), key=lambda d: d["id"])}
    return hashlib.sha1(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
