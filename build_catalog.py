"""Compile ULPC sheet_definitions + palette_definitions into catalog.json for the browser generator.

Run:  python build_catalog.py
Output: catalog.json  { items: {id: item}, palettes: {material: {version: {name: [hex...]}}}, materials: {material: {default, base}} }

item = {
  id, name, type, tags,
  layers: [ { z, paths: {bodyType: "relative/path/"}, mode: "single"|"variants", variants: [..] } ],
  recolors: [ { material, version, base, palettes: [ "version" | "material.version" ] } ],
  matchBody: bool
}
"""
import json, os, glob

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ulpc")
SHEETS = os.path.join(ROOT, "spritesheets")
ANIM_PROBE = "walk"  # animation used to detect layout


def load(p):
    with open(p, encoding="utf8") as f:
        return json.load(f)


def material_meta():
    mats = {}
    pals = {}
    for meta in glob.glob(os.path.join(ROOT, "palette_definitions", "*", "meta_*.json")):
        mat = os.path.basename(os.path.dirname(meta))
        m = load(meta)
        mats[mat] = {"default": m["default"], "base": m["base"]}
        pals[mat] = {}
        for pf in glob.glob(os.path.join(ROOT, "palette_definitions", mat, f"{mat}_*.json")):
            version = os.path.basename(pf)[len(mat) + 1 : -5]
            pals[mat][version] = load(pf)
    return mats, pals


def layer_mode(rel):
    base = os.path.join(SHEETS, rel)
    if os.path.isfile(os.path.join(base, ANIM_PROBE + ".png")):
        return "single", None
    d = os.path.join(base, ANIM_PROBE)
    if os.path.isdir(d):
        return "variants", sorted(f[:-4] for f in os.listdir(d) if f.endswith(".png"))
    return None, None


def norm_recolors(rec):
    """Return list of {material, base, palettes}. Handles single and color_N forms."""
    if not rec:
        return []
    if "material" in rec:
        return [{"material": rec["material"], "base": rec.get("base"), "palettes": rec.get("palettes", [])}]
    out = []
    for k, v in rec.items():
        if isinstance(v, dict) and "material" in v:
            out.append({"material": v["material"], "base": v.get("base"), "palettes": v.get("palettes", []), "slot": k, "label": v.get("label")})
    return out


def build():
    mats, pals = material_meta()
    items = {}
    for jf in glob.glob(os.path.join(ROOT, "sheet_definitions", "**", "*.json"), recursive=True):
        if os.path.basename(jf).startswith("meta_"):
            continue
        d = load(jf)
        if "layer_1" not in d:
            continue
        rel_id = os.path.relpath(jf, os.path.join(ROOT, "sheet_definitions")).replace("\\", "/")[:-5]
        layers = []
        n = 1
        while f"layer_{n}" in d:
            L = d[f"layer_{n}"]
            paths = {k: v for k, v in L.items() if k != "zPos" and isinstance(v, str)}
            mode, variants = None, None
            for p in paths.values():
                mode, variants = layer_mode(p)
                if mode:
                    break
            if mode:
                layers.append({"z": L.get("zPos", 0), "paths": paths, "mode": mode, "variants": variants or d.get("variants")})
            n += 1
        if not layers:
            continue
        items[rel_id] = {
            "id": rel_id,
            "name": d.get("name", rel_id),
            "type": d.get("type_name", ""),
            "tags": d.get("tags", []),
            "layers": layers,
            "recolors": norm_recolors(d.get("recolors")),
            "matchBody": bool(d.get("match_body_color")),
            "variants": d.get("variants"),
        }
    out = {"items": items, "palettes": pals, "materials": mats}
    with open(os.path.join(os.path.dirname(ROOT), "catalog.json"), "w", encoding="utf8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(items)} items written")
    # quick summary by type
    from collections import Counter
    print(Counter(i["type"] for i in items.values()).most_common())


if __name__ == "__main__":
    build()
