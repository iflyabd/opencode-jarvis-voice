"""
Piper voice discovery.

Finds local Piper voices (an .onnx model plus its .onnx.json config) anywhere on
the machine, so a voice downloaded from GitHub keeps working no matter which
device or directory it landed in.

Resolution order:
  1. explicit path/name from JARVIS_VOICE_PIPER_VOICE
  2. registry written by `voice use <file>`   (~/.config/jarvis-voice/voices.json)
  3. the `jarvis` voice, if present (a voice literally named jarvis wins)
  4. VOICE_PREFERENCES order
  5. any usable voice
"""

from __future__ import annotations

import json
import os
import shutil
import time
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

import jv_config as cfg

# Scanning every search folder is wasted work on repeated health checks, so the
# result is memoised briefly. `voice use` / `voice fetch` invalidate it.
DISCOVER_TTL = 20.0
_discover_cache: "tuple[float, list[Voice]] | None" = None


def invalidate_cache() -> None:
    global _discover_cache
    _discover_cache = None


@dataclass
class Voice:
    name: str
    model: str
    config: str | None
    sample_rate: int = 22050
    languages: list | None = None
    speakers: int = 1
    source: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ready"] = bool(self.model and Path(self.model).exists())
        return d


# ----------------------------------------------------------------------------
# Config parsing
# ----------------------------------------------------------------------------

def read_voice_config(config_path: Path) -> dict:
    try:
        return json.loads(Path(config_path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def _voice_meta(model: Path, config: Path | None) -> tuple[int, list, int]:
    sr, langs, speakers = 22050, [], 1
    if config and config.exists():
        data = read_voice_config(config)
        sr = int(data.get("audio", {}).get("sample_rate") or data.get("sample_rate") or 22050)
        code = data.get("language")
        if isinstance(code, dict):
            code = code.get("code")
        if isinstance(code, str):
            langs = [code]
        elif isinstance(code, (list, tuple)):
            langs = [str(c) for c in code]
        speakers = int((data.get("num_speakers") or 1) or 1)
    return sr, langs, speakers


def voice_from_model(model: Path, source: str = "scan") -> Voice | None:
    model = Path(model)
    if not model.exists():
        return None
    # Piper configs are either `x.onnx.json` or `x.json`
    config = None
    for cand in (
        Path(str(model) + ".json"),
        model.with_suffix(".onnx.json"),
        model.with_suffix(".json"),
    ):
        if cand.exists():
            config = cand
            break
    sr, langs, speakers = _voice_meta(model, config)
    name = model.stem
    if name.endswith(".onnx"):
        name = name[:-5]
    return Voice(name=name, model=str(model), config=str(config) if config else None,
                 sample_rate=sr, languages=langs, speakers=speakers, source=source)


# ----------------------------------------------------------------------------
# Discovery
# ----------------------------------------------------------------------------

def _scan_dir(root: Path, depth: int = 4, limit: int = 4000) -> list[Voice]:
    """Bounded recursive scan so a huge home directory cannot stall startup."""
    found: list[Voice] = []
    if not root.exists():
        return found
    seen = 0
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack and seen < limit:
        cur, d = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except Exception:
            continue
        for entry in entries:
            seen += 1
            if seen > limit:
                break
            try:
                if entry.is_dir(follow_symlinks=False):
                    if d < depth and not entry.name.startswith("."):
                        stack.append((Path(entry.path), d + 1))
                elif entry.name.endswith(".onnx"):
                    v = voice_from_model(Path(entry.path))
                    if v:
                        found.append(v)
            except Exception:
                continue
    return found


def registry_voices() -> list[Voice]:
    try:
        data = json.loads(cfg.VOICE_REGISTRY.read_text())
    except Exception:
        return []
    out: list[Voice] = []
    paths = data if isinstance(data, list) else data.get("voices", [])
    for p in paths:
        try:
            q = Path(str(p)).expanduser()
            if q.is_dir():
                out.extend(_scan_dir(q, depth=2))
            else:
                v = voice_from_model(q, source="registry")
                if v:
                    out.append(v)
        except Exception:
            continue
    return out


def env_voices() -> list[Voice]:
    raw = (cfg.PIPER_VOICE or "").strip()
    if not raw:
        return []
    out: list[Voice] = []
    for part in raw.split(os.pathsep):
        part = part.strip()
        if not part:
            continue
        p = Path(part).expanduser()
        if p.is_dir():
            out.extend(_scan_dir(p, depth=2))
        else:
            v = voice_from_model(p, source="env")
            if v:
                out.append(v)
    return out


def discover(verbose: bool = False, use_cache: bool = True) -> list[Voice]:
    """All voices found, deduplicated by resolved model path, in priority order."""
    global _discover_cache
    if use_cache and _discover_cache is not None:
        stamp, cached = _discover_cache
        if time.time() - stamp < DISCOVER_TTL and not verbose:
            return list(cached)

    ordered: list[Voice] = []
    ordered.extend(env_voices())
    ordered.extend(registry_voices())
    for d in cfg.VOICE_SEARCH_DIRS:
        if d and Path(d).exists():
            ordered.extend(_scan_dir(Path(d)))

    seen: set[str] = set()
    unique: list[Voice] = []
    for v in ordered:
        try:
            key = str(Path(v.model).resolve())
        except Exception:
            key = v.model
        if key in seen:
            continue
        seen.add(key)
        unique.append(v)
    if verbose:
        print(f"[voices] searched {len(cfg.VOICE_SEARCH_DIRS)} locations, found {len(unique)}")
        for v in unique:
            print(f"  - {v.name}  ({v.sample_rate} Hz)  {v.model}")
    _discover_cache = (time.time(), unique)
    return unique


def _score(voice: Voice) -> tuple[int, int]:
    """Lower is better. Priority list position first, then exact 'jarvis' match."""
    name = voice.name.lower()
    best = len(cfg.VOICE_PREFERENCES) + 10
    for i, pref in enumerate(cfg.VOICE_PREFERENCES):
        if pref.lower() in name:
            best = min(best, i)
    exact = 0 if "jarvis" in name else 1
    return (best, exact)


def resolve(prefer: str | None = None, verbose: bool = False) -> Voice | None:
    """Pick the best available voice, or None when nothing usable is installed."""
    all_voices = discover(verbose=verbose)
    if not all_voices:
        return None
    if prefer:
        p = Path(prefer).expanduser()
        if p.exists():
            v = voice_from_model(p, source="explicit")
            if v:
                return v
        needle = prefer.lower()
        for v in all_voices:
            if needle == v.name.lower() or needle in v.name.lower():
                return v
    return sorted(all_voices, key=_score)[0]


def remember(path: str | Path) -> dict:
    """Persist a voice location so it survives restarts and device changes."""
    data = {}
    if cfg.VOICE_REGISTRY.exists():
        try:
            data = json.loads(cfg.VOICE_REGISTRY.read_text())
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    voices = list(data.get("voices", []))
    ap = str(path)
    if ap not in voices:
        voices.insert(0, ap)
    data["voices"] = voices[:40]
    cfg.VOICE_REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    cfg.VOICE_REGISTRY.write_text(json.dumps(data, indent=2))
    invalidate_cache()
    return data


# ----------------------------------------------------------------------------
# Optional download (only on explicit request)
# ----------------------------------------------------------------------------

CATALOG = {
    # name -> (path under the voice repo, sample rate[, base URL])
    # Entries without a base URL come from the rhasspy/piper-voices repo.
    "jarvis-medium": ("en/en_GB/jarvis/medium/jarvis-medium", 22050, "https://huggingface.co/jgkawell/jarvis/resolve/main"),
    "en_GB-alan-medium": ("en/en_GB/alan/medium/en_GB-alan-medium", 22050),
    "en_GB-alan-low": ("en/en_GB/alan/low/en_GB-alan-low", 16000),
    "en_GB-northern_english_male-medium": (
        "en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium",
        22050,
    ),
    "en_US-ryan-high": ("en/en_US/ryan/high/en_US-ryan-high", 22050),
    "en_US-lessac-medium": ("en/en_US/lessac/medium/en_US-lessac-medium", 22050),
    "en_GB-alba-medium": ("en/en_GB/alba/medium/en_GB-alba-medium", 22050),
}


def fetch(name: str, dest_dir: Path | None = None, quiet: bool = False) -> str:
    """Download a voice from its public repository. Returns the model path."""
    if name not in CATALOG:
        raise SystemExit(
            f"unknown voice '{name}'. Known: {', '.join(sorted(CATALOG))}\n"
            "Or point at your own file:  voice use /path/to/voice.onnx"
        )
    entry = CATALOG[name]
    rel, _sr = entry[0], entry[1]
    base = entry[2] if len(entry) > 2 else cfg.VOICE_CATALOG_URL
    dest = Path(dest_dir) if dest_dir else (cfg.CONFIG_DIR / "voices")
    dest.mkdir(parents=True, exist_ok=True)
    model_path = dest / f"{name}.onnx"
    config_path = dest / f"{name}.onnx.json"

    for url, out in (
        (f"{base}/{rel}.onnx?download=true", model_path),
        (f"{base}/{rel}.onnx.json?download=true", config_path),
    ):
        if out.exists() and out.stat().st_size > 0:
            if not quiet:
                print(f"[voices] already have {out.name}")
            continue
        if not quiet:
            print(f"[voices] downloading {out.name} ...")
        tmp = out.with_suffix(out.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(out)
    remember(model_path)
    if not quiet:
        print(f"[voices] ready: {model_path}")
    return str(model_path)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def _main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "list"
    if cmd == "list":
        voices = discover(verbose=False)
        if not voices:
            print("No Piper voices found.")
            print("Point the daemon at yours:  voice use /path/to/voice.onnx")
            print("Or download one:            voice fetch jarvis-medium")
            return 1
        best = resolve()
        for v in sorted(voices, key=_score):
            mark = "*" if best and v.model == best.model else " "
            cfgp = "no config" if not v.config else ""
            print(f"{mark} {v.name:<42} {v.sample_rate:>6} Hz  {cfgp}")
        print(f"\n* = selected.  {len(voices)} voice(s) found.")
        return 0
    if cmd == "path":
        v = resolve(prefer=argv[2] if len(argv) > 2 else None)
        if not v:
            return 1
        print(v.model)
        return 0
    if cmd == "json":
        v = resolve(prefer=argv[2] if len(argv) > 2 else None)
        print(json.dumps(v.to_dict() if v else {}, indent=2))
        return 0 if v else 1
    if cmd == "use" and len(argv) > 2:
        p = Path(argv[2]).expanduser()
        v = voice_from_model(p, source="explicit")
        if not v:
            print(f"not a usable Piper voice: {p}", flush=True)
            return 2
        remember(p if p.is_dir() else v.model)
        print(f"registered: {v.model}")
        return 0
    if cmd == "fetch":
        fetch(argv[2] if len(argv) > 2 else "jarvis-medium")
        return 0
    if cmd == "where":
        print("Search locations:")
        for d in cfg.VOICE_SEARCH_DIRS:
            print(f"  {'ok ' if Path(d).exists() else '-- '} {d}")
        print(f"registry: {cfg.VOICE_REGISTRY}")
        return 0
    if cmd == "known":
        for k in sorted(CATALOG):
            entry = CATALOG[k]
            rel, sr = entry[0], entry[1]
            home = "rhasspy" if len(entry) <= 2 else "jarvis"
            print(f"  {k:<42} {sr} Hz  ({home})")
        return 0
    print("usage: jv_voices.py [list|path|json|use <file>|fetch <name>|where|known]", flush=True)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
