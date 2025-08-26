from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
from io import BytesIO
import re
import unicodedata
import math

app = FastAPI(title="HT-810 Uploader API", version="1.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SeriesOut(BaseModel):
    timestamp: str
    temperature: float

class UploadResponse(BaseModel):
    time_key: str
    temp_key: str
    data: list[SeriesOut]
    stats: dict
    resampled: list[SeriesOut]   # resumida (1H)

# Regex para identificar colunas por nome
TEMP_NAME_PAT = re.compile(r"(temp|temperatura|°c|celsius|℃|\bt\b)", re.I)
TIME_NAME_PAT = re.compile(r"(timestamp|datahora|date_time|datetime|tempo|time|\bdata\b|\bhora\b)", re.I)

# --------------------- Helpers de normalização ---------------------
def _normalize_text(txt: str) -> str:
    txt = str(txt).strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    txt = txt.replace("℃", "c").replace("°c", "c")
    txt = txt.replace(" ", "").replace("\n", "").replace("\t", "")
    return txt

def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [_normalize_text(c) for c in df.columns]
    return df

def _clean_numeric_series(s: pd.Series) -> pd.Series:
    def _clean_cell(v):
        if pd.isna(v):
            return math.nan
        txt = str(v).strip().lower()
        for trash in ["°c", "℃", " c", "c ", " c ", "°", " celsius"]:
            txt = txt.replace(trash, "")
        txt = txt.replace(" ", "")

        if "," in txt and "." in txt:
            last_comma = txt.rfind(",")
            last_dot = txt.rfind(".")
            if last_comma > last_dot:
                txt = txt.replace(".", "")
                txt = txt.replace(",", ".")
            else:
                txt = txt.replace(",", "")
        else:
            if "," in txt:
                txt = txt.replace(",", ".")
        txt = re.sub(r"[^0-9\.\-]+", "", txt)

        if txt in ("", ".", "-", "-.", ".-"):
            return math.nan
        try:
            return float(txt)
        except Exception:
            return math.nan

    cleaned = s.map(_clean_cell)
    return cleaned

def _to_datetime_score(s: pd.Series) -> tuple[pd.Series, float]:
    dt = pd.to_datetime(s, errors="coerce", dayfirst=True)
    score = float(dt.notna().mean())
    return dt, score

# --------------------- Detecção de colunas ---------------------
def _pick_time_column(df: pd.DataFrame) -> tuple[str, str | None, pd.Series]:
    candidates = list(df.columns)
    named = [c for c in candidates if TIME_NAME_PAT.search(c)]
    scored = []
    for c in (named or candidates):
        series, score = _to_datetime_score(df[c])
        scored.append((score, c, series))
    scored.sort(reverse=True)
    best_score, best_col, best_series = scored[0]

    if best_score < 0.60:
        data_cols = [c for c in candidates if "data" in c]
        hora_cols = [c for c in candidates if any(tok in c for tok in ["hora", "time", "tempo"])]
        combo_best = (0.0, None, None, None)
        for dcol in data_cols:
            for hcol in hora_cols:
                d = pd.to_datetime(df[dcol], errors="coerce", dayfirst=True).dt.strftime("%Y-%m-%d")
                h = pd.to_datetime(df[hcol].astype(str), errors="coerce").dt.time.astype(str)
                ts = pd.to_datetime(d + " " + h, errors="coerce")
                score = float(ts.notna().mean())
                if score > combo_best[0]:
                    combo_best = (score, dcol, hcol, ts)
        if combo_best[0] >= best_score:
            return combo_best[1], combo_best[2], combo_best[3]

    return best_col, None, best_series

def _column_numeric_quality(col: pd.Series) -> tuple[float, float]:
    cleaned = _clean_numeric_series(col)
    pct = float(cleaned.notna().mean())
    med = float(cleaned.median()) if cleaned.notna().any() else float("nan")
    return pct, med

def _pick_temp_column(df: pd.DataFrame) -> str:
    candidates = list(df.columns)
    scored = []
    for c in candidates:
        name_score = 1.0 if TEMP_NAME_PAT.search(c) else 0.0
        pct_num, median_val = _column_numeric_quality(df[c])
        plaus = 1.0 if (not math.isnan(median_val) and -50.0 <= median_val <= 100.0) else 0.0
        score = name_score * 2.0 + pct_num * 1.5 + plaus * 2.5
        scored.append((score, name_score, pct_num, plaus, c, median_val))
    scored.sort(reverse=True)
    best = scored[0]
    _, _, _, _, col, _ = best
    return col

# --------------------- Leitura ---------------------
def _read_any_excel(content: bytes, filename: str) -> pd.DataFrame:
    name = filename.lower()
    bio = BytesIO(content)

    if name.endswith(".csv"):
        for sep in [",", ";", "\t", "|"]:
            for enc in ["utf-8", "latin-1", "cp1252"]:
                try:
                    bio.seek(0)
                    df = pd.read_csv(bio, sep=sep, encoding=enc, engine="python")
                    if df.shape[1] >= 2:
                        return df
                except Exception:
                    pass
        raise HTTPException(status_code=400, detail="Não consegui ler o CSV. Verifique o separador/encoding.")
    elif name.endswith(".xlsx"):
        return pd.read_excel(bio, engine="openpyxl")
    elif name.endswith(".xls"):
        return pd.read_excel(bio, engine="xlrd")
    else:
        return pd.read_excel(bio)

def _final_sanity_trim(temp: pd.Series) -> pd.Series:
    temp = temp.where(~(temp > 1000), other=pd.NA)
    temp = temp.where(~(temp < -100), other=pd.NA)
    return temp

# --------------------- Endpoint ---------------------
@app.post("/api/upload", response_model=UploadResponse)
async def upload(
    file: UploadFile = File(...),
    start: str | None = Form(None),
    end: str | None = Form(None),
):
    content = await file.read()
    df = _read_any_excel(content, file.filename)

    df = _normalize_columns(df)
    df = df.dropna(axis=1, how="all").dropna(axis=0, how="all")

    if df.shape[1] < 2:
        raise HTTPException(status_code=400, detail=f"Planilha com poucas colunas. Colunas lidas: {df.columns.tolist()}")

    time_col, time2, ts_series = _pick_time_column(df)
    temp_col = _pick_temp_column(df)

    ts = ts_series
    if time2 is not None and ts.dtype == "O":
        d = pd.to_datetime(df[time_col], errors="coerce", dayfirst=True).dt.strftime("%Y-%m-%d")
        h = pd.to_datetime(df[time2].astype(str), errors="coerce").dt.time.astype(str)
        ts = pd.to_datetime(d + " " + h, errors="coerce")

    temp = _clean_numeric_series(df[temp_col])
    temp = _final_sanity_trim(temp)

    out = pd.DataFrame({"timestamp": ts, "temperature": temp}).dropna(subset=["timestamp", "temperature"])
    out = out.sort_values("timestamp")

    if out.empty:
        raise HTTPException(status_code=400, detail="Não consegui gerar série de tempo/temperatura.")

    # >>> NOVO: aplicar filtro de período no BACKEND (se vier)
    if start or end:
        start_dt = pd.to_datetime(start, errors="coerce") if start else None
        end_dt = pd.to_datetime(end, errors="coerce") if end else None
        mask = pd.Series(True, index=out.index)
        if start_dt is not None:
            mask &= out["timestamp"] >= start_dt
        if end_dt is not None:
            mask &= out["timestamp"] <= end_dt
        out = out.loc[mask]

    # Estatísticas (sobre o recorte filtrado, se houver)
    stats = {
        "min": float(out["temperature"].min()),
        "max": float(out["temperature"].max()),
        "avg": float(out["temperature"].mean()),
        "count": int(out["temperature"].count()),
        "start": out["timestamp"].iloc[0].isoformat(),
        "end": out["timestamp"].iloc[-1].isoformat(),
        "time_col": time_col if time2 is None else f"{time_col}+{time2}",
        "temp_col": temp_col,
    }

    # Dados originais (já filtrados)
    data = [
        {"timestamp": row["timestamp"].isoformat(), "temperature": float(row["temperature"])}
        for _, row in out.iterrows()
    ]

    # >>> NOVO: Dados resumidos (a cada 1 hora)
    out_resampled = (
        out.set_index("timestamp")
           .resample("1H")
           .mean()
           .dropna()
           .reset_index()
    )
    resampled = [
        {"timestamp": row["timestamp"].isoformat(), "temperature": float(row["temperature"])}
        for _, row in out_resampled.iterrows()
    ]

    return {
        "time_key": "timestamp",
        "temp_key": "temperature",
        "data": data,
        "resampled": resampled,
        "stats": stats,
    }

@app.get("/health")
async def health():
    return {"status": "ok"}
