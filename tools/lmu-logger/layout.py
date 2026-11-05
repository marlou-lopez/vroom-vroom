"""Compute struct layouts from LMU's own C++ headers, at runtime.

LMU ships the description of its shared-memory block as headers in
`<LMU install>/Support/SharedMemoryInterface/`. Their licence forbids redistributing or modifying
them, so nothing from them lives in this repo. Instead this module contains a small C/C++
declaration parser (standard library only) that reads the user's installed copy and works out the
size and offset of every member the way a Windows x64 compiler would.

Supported: `#pragma pack(push, N)` / `pop` / `(N)`, `#define NAME <integer expression>`, local
`#include "x"`, enums (also `enum class X : type`), structs and unions (also anonymous ones, whose
members are reachable from the parent), single inheritance, arrays (multi-dimensional, sizes may be
constant expressions using defines and enum constants), pointers, nested structs. Skipped: classes,
methods, constructors, operators, inline function bodies, typedefs, `static` members,
preprocessor conditionals (everything is treated as active).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MAX_PATH = 260  # MAX_PATH comes from windows.h, which is not parsed
HEADER_SUBDIR = Path("Support") / "SharedMemoryInterface"
DEFAULT_ENTRY = "SharedMemoryInterface.hpp"
DEFAULT_WINDOWS_LMU_DIR = r"C:\Program Files (x86)\Steam\steamapps\common\Le Mans Ultimate"


class LayoutError(Exception):
    pass


# ---------------------------------------------------------------- types

@dataclass(frozen=True)
class Prim:
    name: str
    size: int
    code: str   # struct-module code (little endian, no alignment)
    kind: str   # int | uint | float | bool | char | ptr


def _prims() -> dict[str, Prim]:
    t: dict[str, Prim] = {}

    def add(names, size, code, kind):
        for n in names.split(","):
            t[n.strip()] = Prim(n.strip(), size, code, kind)

    add("char", 1, "b", "char")
    add("signed char,int8_t,__int8,INT8,CHAR", 1, "b", "int")
    add("unsigned char,uint8_t,__uint8,BYTE,UINT8,UCHAR", 1, "B", "uint")
    add("bool,BOOLEAN", 1, "?", "bool")
    add("short,short int,int16_t,__int16,SHORT,INT16", 2, "h", "int")
    add("unsigned short,unsigned short int,uint16_t,WORD,USHORT,UINT16,wchar_t,char16_t", 2, "H", "uint")
    add("int,signed,signed int,int32_t,__int32,INT,INT32,LONG,long,long int,BOOL", 4, "i", "int")
    add("unsigned,unsigned int,uint32_t,__uint32,UINT,UINT32,DWORD,ULONG,unsigned long,"
        "unsigned long int,char32_t", 4, "I", "uint")
    add("long long,long long int,int64_t,__int64,INT64,LONGLONG,ptrdiff_t,intptr_t,SSIZE_T,LONG_PTR",
        8, "q", "int")
    add("unsigned long long,unsigned long long int,uint64_t,unsigned __int64,UINT64,ULONGLONG,"
        "size_t,uintptr_t,SIZE_T,ULONG_PTR,DWORD_PTR", 8, "Q", "uint")
    add("float,FLOAT,float_t", 4, "f", "float")
    add("double,long double,DOUBLE", 8, "d", "float")
    add("HWND,HANDLE,HINSTANCE,HMODULE,LPVOID,PVOID,LPCVOID,LPSTR,LPCSTR,HDC,HRESULT_PTR",
        8, "Q", "ptr")
    return t


PRIMS = _prims()
_TYPE_WORDS = {"unsigned", "signed", "long", "short", "int", "char", "double", "float", "bool", "__int64",
               "__int32", "__int16", "__int8"}


def _align_up(n: int, a: int) -> int:
    return (n + a - 1) // a * a


@dataclass
class Member:
    name: str | None          # None: anonymous struct/union (or base class)
    type: "Prim | Record"
    offset: int
    dims: tuple[int, ...] = ()

    @property
    def count(self) -> int:
        n = 1
        for d in self.dims:
            n *= d
        return n


@dataclass
class Record:
    name: str
    is_union: bool
    members: list[Member] = field(default_factory=list)
    size: int = 1
    align: int = 1

    def find(self, name: str) -> tuple[int, Member]:
        """Offset (within this record) and member of a named field, looking through anonymous
        members and base classes."""
        for m in self.members:
            if m.name == name:
                return m.offset, m
        for m in self.members:
            if m.name is None and isinstance(m.type, Record):
                try:
                    off, found = m.type.find(name)
                    return m.offset + off, found
                except KeyError:
                    pass
        raise KeyError(f"{self.name} has no member {name}")

    def offsetof(self, name: str) -> int:
        return self.find(name)[0]


@dataclass(frozen=True)
class Scalar:
    name: str       # flattened name, e.g. mPos_x, mWheel_2_mBrakeTemp
    offset: int     # offset from the start of the record being flattened
    prim: Prim


def flatten(rec: Record, base: int = 0, prefix: str = "", skip_char_arrays: bool = True):
    """Yield every scalar of a record in layout order with a flattened name.

    A name is the field names joined with `_`; array elements add their index; anonymous members
    add nothing. Of a union only the first alternative is taken (so a vector with `x, y, z` and
    `data[3]` views yields x, y, z once). Pointers are skipped, and so are `char` arrays (strings)
    unless `skip_char_arrays` is false.
    """
    members = rec.members[:1] if rec.is_union else rec.members
    for m in members:
        p = prefix + (m.name + "_" if m.name else "")
        idx_sets = [()]
        for d in m.dims:
            idx_sets = [i + (k,) for i in idx_sets for k in range(d)]
        for idx in idx_sets:
            if isinstance(m.type, Record):
                stride = m.type.size
            else:
                stride = m.type.size
            lin = 0
            for k, d in zip(idx, m.dims):
                lin = lin * d + k
            off = base + m.offset + lin * stride
            suffix = "_".join(str(k) for k in idx)
            if isinstance(m.type, Record):
                yield from flatten(m.type, off, p + (suffix + "_" if suffix else ""), skip_char_arrays)
            else:
                if m.type.kind == "ptr":
                    continue
                if m.type.kind == "char" and m.dims and skip_char_arrays:
                    continue
                name = (p + suffix) if suffix else p[:-1] if m.name else p
                yield Scalar(name, off, m.type)


# ---------------------------------------------------------------- tokenizer

_TOKEN = re.compile(
    r"""[A-Za-z_]\w*
      |0[xX][0-9a-fA-F]+[uUlL]*
      |\d+\.?\d*(?:[eE][+-]?\d+)?[fFuUlL]*
      |"(?:\\.|[^"\\])*"
      |'(?:\\.|[^'\\])*'
      |::|<<|>>|->|\+\+|--|\.\.\.
      |\S""", re.X)


def _strip_comments(src: str) -> str:
    def blank(m):
        return re.sub(r"[^\n]", " ", m.group(0))
    src = re.sub(r"/\*.*?\*/", blank, src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def _int_literal(tok: str) -> int:
    t = re.sub(r"[uUlL]+$", "", tok)
    if re.fullmatch(r"0[0-7]+", t):
        return int(t, 8)
    return int(t, 0)


class _Parser:
    def __init__(self, base_dir: Path, defines: dict | None = None):
        self.base_dir = base_dir
        self.defines: dict[str, list[str]] = {}
        self.consts: dict[str, int] = {}
        self.records: dict[str, Record] = {}
        self.enums: dict[str, Prim] = {}
        self.pack_stack: list[int] = []
        self.pack = 8
        self.toks: list[str] = []
        self.i = 0
        self._seen: set[Path] = set()
        for k, v in (defines or {}).items():
            self.consts[k] = int(v)

    # -- preprocessing into one token stream
    def add_source(self, text: str, origin: Path | None = None):
        text = _strip_comments(text).replace("\\\n", " ")
        pending: list[str] = []
        for line in text.split("\n"):
            s = line.strip()
            if not s.startswith("#"):
                pending.extend(_TOKEN.findall(line))
                continue
            d = re.match(r"#\s*(\w+)\s*(.*)", s)
            if not d:
                continue
            kind, rest = d.group(1), d.group(2)
            if kind == "include":
                m = re.match(r'"([^"]+)"', rest)
                if m and origin is not None:
                    path = (origin.parent / m.group(1))
                    if path.is_file() and path.resolve() not in self._seen:
                        self.add_file(path, into=pending)
            elif kind == "define":
                m = re.match(r"(\w+)(\()?\s*(.*)", rest)
                if m and not m.group(2):
                    self.defines[m.group(1)] = _TOKEN.findall(m.group(3))
            elif kind == "pragma":
                m = re.match(r"pack\s*\(\s*(.*?)\s*\)", rest)
                if m:
                    pending.append("#pack " + re.sub(r"\s+", "", m.group(1)))
        self.toks.extend(pending)

    def add_file(self, path: Path, into: list | None = None):
        path = Path(path)
        self._seen.add(path.resolve())
        text = path.read_text(encoding="utf-8", errors="replace")
        before = len(self.toks)
        if into is not None:
            # included file's tokens go where the include was, i.e. before the pending ones
            self.toks.extend(into)
            into.clear()
        self.add_source(text, path)
        return before

    # -- expression evaluation
    def eval_tokens(self, toks: list[str], depth: int = 0) -> int:
        if depth > 20:
            raise LayoutError("define recursion too deep")
        pos = 0

        def peek():
            return toks[pos] if pos < len(toks) else None

        def take():
            nonlocal pos
            t = toks[pos]
            pos += 1
            return t

        def primary():
            t = take()
            if t == "(":
                v = expr(0)
                if take() != ")":
                    raise LayoutError("expected )")
                return v
            if t in ("-", "+", "~", "!"):
                v = primary()
                return {"-": -v, "+": v, "~": ~v, "!": int(not v)}[t]
            if re.match(r"\d", t):
                return _int_literal(t)
            if re.match(r"[A-Za-z_]", t):
                name = t
                while peek() == "::":
                    take()
                    name = take()
                return self.lookup(name, depth)
            raise LayoutError(f"cannot evaluate token {t!r}")

        prec = {"|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6}
        ops = {"|": lambda a, b: a | b, "^": lambda a, b: a ^ b, "&": lambda a, b: a & b,
               "<<": lambda a, b: a << b, ">>": lambda a, b: a >> b, "+": lambda a, b: a + b,
               "-": lambda a, b: a - b, "*": lambda a, b: a * b, "/": lambda a, b: a // b,
               "%": lambda a, b: a % b}

        def expr(minp):
            left = primary()
            while peek() in prec and prec[peek()] >= minp:
                op = take()
                left = ops[op](left, expr(prec[op] + 1))
            return left

        v = expr(0)
        if pos != len(toks):
            raise LayoutError(f"trailing tokens in expression: {toks[pos:]}")
        return v

    def lookup(self, name: str, depth: int) -> int:
        if name in self.consts:
            return self.consts[name]
        if name in self.defines:
            return self.eval_tokens(self.defines[name], depth + 1)
        if name == "MAX_PATH":
            return DEFAULT_MAX_PATH
        raise LayoutError(f"unknown constant {name}")

    # -- token helpers
    def peek(self, k: int = 0):
        j = self.i + k
        return self.toks[j] if j < len(self.toks) else None

    def take(self) -> str:
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect(self, s: str):
        t = self.take()
        if t != s:
            raise LayoutError(f"expected {s!r}, got {t!r} near {' '.join(self.toks[max(0, self.i - 8):self.i])}")

    def handle_pack(self, tok: str):
        arg = tok[len("#pack "):] if tok.startswith("#pack ") else ""
        parts = [p for p in arg.split(",") if p]
        if parts and parts[0] == "push":
            self.pack_stack.append(self.pack)
            if len(parts) > 1 and parts[-1].isdigit():
                self.pack = int(parts[-1])
        elif parts and parts[0] == "pop":
            if self.pack_stack:
                self.pack = self.pack_stack.pop()
        elif parts and parts[0].isdigit():
            self.pack = int(parts[0])
        else:
            self.pack = 8

    def skip_balanced(self, open_: str, close: str):
        """At an opening token: skip to just past its matching close."""
        depth = 0
        while True:
            t = self.take()
            if t == open_:
                depth += 1
            elif t == close:
                depth -= 1
                if depth == 0:
                    return

    def skip_statement(self):
        """Skip one declaration: a ';'-terminated one or one ending in a function body."""
        prev = None
        while self.i < len(self.toks):
            t = self.peek()
            if t == ";":
                self.i += 1
                return
            if t == "(":
                self.skip_balanced("(", ")")
                prev = ")"
                continue
            if t == "[":
                self.skip_balanced("[", "]")
                prev = "]"
                continue
            if t == "{":
                self.skip_balanced("{", "}")
                if prev not in ("=", None) and prev != ",":
                    # a function body ends the declaration (an initializer is followed by ';')
                    if self.peek() == ";":
                        self.i += 1
                    return
                prev = "}"
                continue
            if t.startswith("#pack"):
                self.handle_pack(t)
                self.i += 1
                continue
            prev = t
            self.i += 1

    # -- types
    def parse_type_name(self):
        """Parse a (possibly multi-word) type at the cursor; returns Prim | Record | str(unresolved)."""
        words = []
        while self.peek() in ("const", "volatile", "struct", "class", "enum", "union", "mutable"):
            self.i += 1
        while self.peek() in _TYPE_WORDS and self.peek() is not None:
            words.append(self.take())
        if words:
            while self.peek() in ("const", "volatile"):
                self.i += 1
            ws = [w for w in words if w != "int"] or ["int"]
            if ws == ["unsigned"] or ws == ["signed"]:
                ws = ws + ["int"]
            return PRIMS.get(" ".join(ws)) or PRIMS.get(" ".join(words)) or PRIMS["int"]
        name = self.take()
        while self.peek() == "::":
            self.i += 1
            name = self.take()
        while self.peek() in ("const", "volatile"):
            self.i += 1
        return name

    def resolve(self, t) -> "Prim | Record":
        if isinstance(t, (Prim, Record)):
            return t
        if t in self.records:
            return self.records[t]
        if t in self.enums:
            return self.enums[t]
        if t in PRIMS:
            return PRIMS[t]
        raise LayoutError(f"unknown type {t}")

    # -- declarations
    def parse_all(self):
        self.i = 0
        while self.i < len(self.toks):
            self.parse_top()

    def parse_top(self):
        t = self.peek()
        if t is None:
            return
        if t.startswith("#pack"):
            self.handle_pack(t)
            self.i += 1
        elif t == ";":
            self.i += 1
        elif t in ("typedef", "using", "static", "inline", "template", "extern", "namespace", "class"):
            if t == "class" or t == "template" or t == "namespace":
                self.skip_class_like()
            else:
                self.skip_statement()
        elif t == "enum":
            self.parse_enum()
        elif t in ("struct", "union") and self.looks_like_definition():
            self.parse_record_def()
        else:
            self.skip_statement()

    def skip_class_like(self):
        """`class X : base { ... };` and friends: skip the whole thing."""
        while self.peek() not in ("{", ";"):
            self.i += 1
        if self.peek() == "{":
            self.skip_balanced("{", "}")
        while self.peek() is not None and self.peek() != ";":
            self.i += 1
        self.i += 1

    def looks_like_definition(self) -> bool:
        j = self.i + 1
        while j < len(self.toks) and self.toks[j] not in ("{", ";", "(", "=", "*", "&"):
            j += 1
        return j < len(self.toks) and self.toks[j] == "{"

    def parse_enum(self):
        self.expect("enum")
        if self.peek() in ("class", "struct"):
            self.i += 1
        name = None
        if self.peek() not in (":", "{", ";"):
            name = self.take()
        under = PRIMS["int"]
        if self.peek() == ":":
            self.i += 1
            under = self.resolve(self.parse_type_name())
        if self.peek() != "{":  # forward declaration or use as a type
            self.skip_statement()
            return
        self.i += 1
        nxt = 0
        while self.peek() != "}":
            cname = self.take()
            if self.peek() == "=":
                self.i += 1
                expr = []
                depth = 0
                while not (depth == 0 and self.peek() in (",", "}")):
                    t = self.take()
                    depth += t == "("
                    depth -= t == ")"
                    expr.append(t)
                nxt = self.eval_tokens(expr)
            self.consts[cname] = nxt
            nxt += 1
            if self.peek() == ",":
                self.i += 1
        self.i += 1
        if name:
            self.enums[name] = under if isinstance(under, Prim) else PRIMS["int"]
        while self.peek() is not None and self.peek() != ";":
            self.i += 1
        self.i += 1

    def parse_record_def(self) -> Record:
        """At `struct|union [Name] [: base] { ... }`. Registers the record; consumes up to and
        including the trailing ';' (declarators after the body are ignored at top level)."""
        rec = self.parse_record_body()
        while self.peek() not in (";", None):
            self.i += 1
        self.i += 1
        return rec

    def parse_record_body(self) -> Record:
        kw = self.take()
        name = ""
        if self.peek() not in ("{", ":"):
            name = self.take()
        rec = Record(name, kw == "union")
        pack = self.pack
        base = None
        if self.peek() == ":":
            self.i += 1
            while self.peek() in ("public", "private", "protected"):
                self.i += 1
            base = self.resolve(self.parse_type_name())
            if not isinstance(base, Record):
                raise LayoutError(f"base of {name} is not a struct")
        self.expect("{")
        cursor = 0
        align = 1
        if base is not None:
            rec.members.append(Member(None, base, 0))
            cursor, align = base.size, base.align
        size_end = cursor  # union: max extent
        while self.peek() != "}":
            t = self.peek()
            if t.startswith("#pack"):
                self.handle_pack(t)
                self.i += 1
                continue
            if t in (";",):
                self.i += 1
                continue
            if t in ("public", "private", "protected") and self.peek(1) == ":":
                self.i += 2
                continue
            for decl in self.parse_member_statement():
                mname, mtype, dims = decl
                mtype = self.resolve(mtype) if not isinstance(mtype, (Prim, Record)) else mtype
                n = 1
                for d in dims:
                    n *= d
                msize = mtype.size * n
                malign = min(mtype.align if isinstance(mtype, Record) else mtype.size, pack)
                if rec.is_union:
                    off = 0
                    size_end = max(size_end, msize)
                else:
                    off = _align_up(cursor, malign)
                    cursor = off + msize
                rec.members.append(Member(mname, mtype, off, tuple(dims)))
                align = max(align, malign)
        self.i += 1  # }
        end = size_end if rec.is_union else cursor
        rec.align = align
        rec.size = _align_up(max(end, 1) if not rec.members else end, align)
        if rec.size == 0:
            rec.size = 1
        if name:
            self.records[name] = rec
        return rec

    def parse_member_statement(self):
        """Parse one statement inside a struct. Returns a list of (name|None, type, dims)."""
        t = self.peek()
        if t in ("typedef", "using", "static", "friend", "template", "operator") or t == "~":
            self.skip_statement()
            return []
        if t == "enum":
            self.parse_enum()
            return []
        if t in ("struct", "union", "class") and self.looks_like_definition():
            if t == "class":
                self.skip_class_like()
                return []
            inner = self.parse_record_body()
            out = []
            if self.peek() == ";":
                self.i += 1
                return [(None, inner, [])] if not inner.name else []
            out = self._declarators(inner)
            return out
        # function / constructor / operator? look for '(' before ';' '{' '=' at depth 0
        j = self.i
        depth = 0
        while j < len(self.toks):
            tk = self.toks[j]
            if tk == "[":
                depth += 1
            elif tk == "]":
                depth -= 1
            elif depth == 0 and tk in (";", "{", "="):
                break
            elif depth == 0 and tk == "(":
                self.skip_statement()
                return []
            j += 1
        base_t = self.parse_type_name()
        return self._declarators(base_t)

    def _declarators(self, base_t):
        out = []
        while True:
            ptr = False
            while self.peek() in ("*", "&", "const", "volatile"):
                ptr = ptr or self.peek() in ("*", "&")
                self.i += 1
            name = self.take()
            dims = []
            while self.peek() == "[":
                self.i += 1
                expr = []
                while self.peek() != "]":
                    expr.append(self.take())
                self.i += 1
                dims.append(self.eval_tokens(expr))
            if self.peek() == ":":
                raise LayoutError(f"bit-fields are not supported ({name})")
            if self.peek() == "=":
                depth = 0
                while not (depth == 0 and self.peek() in (",", ";")):
                    tk = self.take()
                    depth += tk in ("(", "{")
                    depth -= tk in (")", "}")
            mtype = PRIMS["HANDLE"] if ptr else base_t
            out.append((name, mtype, dims))
            if self.peek() == ",":
                self.i += 1
                continue
            self.expect(";")
            return out


# ---------------------------------------------------------------- public API

class Layout:
    def __init__(self, records: dict[str, Record], headers_dir: Path | None = None):
        self.records = records
        self.headers_dir = headers_dir

    def record(self, name: str) -> Record:
        try:
            return self.records[name]
        except KeyError:
            raise LayoutError(f"struct {name} not found in the headers") from None

    def sizeof(self, name: str) -> int:
        return self.record(name).size

    def offsetof(self, struct: str, path: str) -> int:
        """Offset of a (dotted) member path, e.g. offsetof("SharedMemoryObjectOut", "scoring.scoringInfo")."""
        rec = self.record(struct)
        off = 0
        parts = path.split(".")
        for k, p in enumerate(parts):
            o, m = rec.find(p)
            off += o
            if k < len(parts) - 1:
                if not isinstance(m.type, Record):
                    raise LayoutError(f"{p} is not a struct")
                rec = m.type
        return off


def parse_text(text: str, defines: dict | None = None) -> Layout:
    """Parse header text given as a string (no includes)."""
    p = _Parser(Path("."), defines)
    p.add_source(text)
    p.parse_all()
    return Layout(p.records)


def parse_file(path, defines: dict | None = None) -> Layout:
    """Parse a header file and the local headers it includes."""
    path = Path(path)
    p = _Parser(path.parent, defines)
    p.add_file(path)
    p.parse_all()
    return Layout(p.records, path.parent)


def steam_library_dirs(vdf_text: str) -> list[str]:
    """Library folders listed in Steam's `libraryfolders.vdf` (the `"path"` entries)."""
    return [m.replace("\\\\", "\\") for m in re.findall(r'"path"\s+"([^"]+)"', vdf_text)]


def _host_path(p: str) -> Path:
    """A Windows path as seen from this OS (D:\\x -> /mnt/d/x under WSL)."""
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m and os.name != "nt":
        return Path("/mnt") / m.group(1).lower() / m.group(2).replace("\\", "/")
    return Path(p)


def steam_roots() -> list[Path]:
    """Steam install folders: the registry value on Windows, plus the default location."""
    roots: list[str] = []
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
                roots.append(winreg.QueryValueEx(k, "SteamPath")[0])
        except OSError:
            pass
    roots.append(r"C:\Program Files (x86)\Steam")
    return [_host_path(r) for r in roots]


def auto_lmu_dirs() -> list[Path]:
    """Candidate LMU folders from Steam's library list (any drive) and the default path."""
    out: list[Path] = []
    for root in steam_roots():
        libs = [root]
        vdf = root / "steamapps" / "libraryfolders.vdf"
        try:
            libs += [_host_path(p) for p in steam_library_dirs(vdf.read_text(errors="replace"))]
        except OSError:
            pass
        out += [lib / "steamapps" / "common" / "Le Mans Ultimate" for lib in libs]
    out.append(_host_path(DEFAULT_WINDOWS_LMU_DIR))
    return out


def find_headers_dir(lmu_dir: str | os.PathLike | None = None) -> Path | None:
    """Locate `Support/SharedMemoryInterface`: --lmu-dir, else $LMU_DIR, else Steam's libraries
    (registry / default Steam folder, `libraryfolders.vdf`), else the default Steam path."""
    if lmu_dir:
        candidates = [Path(lmu_dir)]
    elif os.environ.get("LMU_DIR"):
        candidates = [Path(os.environ["LMU_DIR"])]
    else:
        candidates = auto_lmu_dirs()
    for base in candidates:
        for d in (base / HEADER_SUBDIR, base):
            if (d / DEFAULT_ENTRY).is_file():
                return d
    return None


def load(lmu_dir=None) -> Layout:
    d = find_headers_dir(lmu_dir)
    if d is None:
        raise LayoutError("LMU headers not found: pass --lmu-dir or set LMU_DIR to the Le Mans Ultimate "
                          "folder (it contains Support/SharedMemoryInterface)")
    return parse_file(d / DEFAULT_ENTRY)
