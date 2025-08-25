from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
from io import BytesIO
import re
import unicodedata
import math

app = FastAPI(title="HT-810 Uploader API", version="1.1.0")

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

# Padrões para identificar colunas por nome
TEMP_NAME_PAT = re.compile(r"(temp|temperatura|°c|celsius|℃|\bt\b)", re.I)
TIME_NAME_PAT = re.compile(r"(timestamp|datahora|date_time|datetime|tempo|time|\bdata\b|\bhora\b)", re.I)


# --------------------- Helpers de normalização ---------------------
def _normalize_text(txt: str) -> str:
    """Remove acentos, espaços/quebras e símbolos; tudo minúsculo."""
    txt = str(txt).strip().lower()
    txt = unicodedata.normalize("NFKD", txt)
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    # unifica símbolos de °C
    txt = txt.replace("℃", "c").replace("°c", "c")
    # remove espaços e separadores comuns
    txt = txt.replace(" ", "").replace("\n", "").replace("\t", "")
    return txt


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [_normalize_text(c) for c in df.columns]
    return df


def _clean_numeric_series(s: pd.Series) -> pd.Series:
    """
    Limpa uma série numérica:
    - converte vírgula para ponto
    - trata milhares (1.234,56 -> 1234.56 ; 1,234.56 -> 1234.56)
    - remove textos/símbolos (℃, °C, C)
    """
    def _clean_cell(v):
        if pd.isna(v):
            return math.nan
        txt = str(v).strip().lower()

        # remove símbolos de unidade e lixo
        for trash in ["°c", "℃", " c", "c ", " c ", "°", " celsius"]:
            txt = txt.replace(trash, "")
        txt = txt.replace(" ", "")

        # casos com dois separadores: decide quem é decimal pelo "último" separador
        if "," in txt and "." in txt:
            last_comma = txt.rfind(",")
            last_dot = txt.rfind(".")
            if last_comma > last_dot:
                # padrão pt-BR: "." é milhar, "," é decimal
                txt = txt.replace(".", "")
                txt = txt.replace(",", ".")
            else:
                # padrão en-US: "," é milhar, "." é decimal
                txt = txt.replace(",", "")
        else:
            # só vírgula: vira decimal
            if "," in txt:
                txt = txt.replace(",", ".")

        # tira qualquer coisa que não seja dígito, ponto ou sinal
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
    """Converte para datetime e retorna a série + taxa de sucesso (0..1)."""
    dt = pd.to_datetime(s, errors="coerce", dayfirst=True)
    score = float(dt.notna().mean())
    return dt, score


# --------------------- Detecção de colunas ---------------------
def _pick_time_column(df: pd.DataFrame) -> tuple[str, str | None, pd.Series]:
    """
    Tenta achar melhor coluna de tempo.
    Retorna: (col_time, col_time2_or_None, timestamps_series)
    """
    candidates = list(df.columns)

    # 1) Preferir por NOME
    named = [c for c in candidates if TIME_NAME_PAT.search(c)]
    scored = []
    for c in (named or candidates):
        series, score = _to_datetime_score(df[c])
        scored.append((score, c, series))
    scored.sort(reverse=True)
    best_score, best_col, best_series = scored[0]

    # 2) Tentar par Data+Hora se score baixo
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
    """
    Retorna (pct_numerico, mediana_limpa) após limpeza dos números.
    """
    cleaned = _clean_numeric_series(col)
    pct = float(cleaned.notna().mean())
    med = float(cleaned.median()) if cleaned.notna().any() else float("nan")
    return pct, med


def _pick_temp_column(df: pd.DataFrame) -> str:
    """
    Escolhe a melhor coluna de temperatura por:
    - nome parecido com temperatura
    - % de valores numéricos limpos
    - mediana dentro de uma faixa plausível (−50..100 ºC)
    """
    candidates = list(df.columns)
    scored = []

    for c in candidates:
        name_score = 1.0 if TEMP_NAME_PAT.search(c) else 0.0
        pct_num, median_val = _column_numeric_quality(df[c])

        # faixa plausível (ambiente)
        plaus = 1.0 if (not math.isnan(median_val) and -50.0 <= median_val <= 100.0) else 0.0

        # pontuação final ponderada
        score = name_score * 2.0 + pct_num * 1.5 + plaus * 2.5
        scored.append((score, name_score, pct_num, plaus, c, median_val))

    scored.sort(reverse=True)

    # escolhe o melhor; se tudo muito ruim, ainda assim usa o top-1
    best = scored[0]
    _, name_score, pct_num, plaus, col, median_val = best

    # Se nenhuma coluna parece boa, ainda tentamos o top-1, mas avisamos se necessário
    return col


# --------------------- Pipeline principal ---------------------
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
        try:
            return pd.read_excel(bio, engine="openpyxl")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Erro ao ler .xlsx: {e}")
    elif name.endswith(".xls"):
        try:
            return pd.read_excel(bio, engine="xlrd")
        except Exception as e:
            raise HTTPException(status_code=400, detail=(
                "Erro ao ler .xls. Garanta que o pacote 'xlrd' esteja instalado (pip install xlrd). "
                f"Detalhe: {e}"
            ))
    else:
        try:
            return pd.read_excel(bio)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Formato de arquivo não suportado: {filename}. Detalhe: {e}")


def _final_sanity_trim(temp: pd.Series) -> pd.Series:
    """
    Remove somente extremos completamente fora da realidade (ex.: > 1000 ou < -100).
    (Não filtra -50..100 aqui para não esvaziar séries válidas; esse range já pesa na escolha da coluna.)
    """
    temp = temp.where(~(temp > 1000), other=pd.NA)
    temp = temp.where(~(temp < -100), other=pd.NA)
    return temp


@app.post("/api/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)):
    content = await file.read()
    df = _read_any_excel(content, file.filename)

    # Normaliza cabeçalhos
    df = _normalize_columns(df)
    # Remove colunas/linhas 100% vazias
    df = df.dropna(axis=1, how="all").dropna(axis=0, how="all")

    if df.shape[1] < 2:
        raise HTTPException(status_code=400, detail=f"Planilha com poucas colunas. Colunas lidas: {df.columns.tolist()}")

    # Detecta tempo
    time_col, time2, ts_series = _pick_time_column(df)
    # Detecta temperatura
    temp_col = _pick_temp_column(df)

    # Converte
    ts = ts_series  # já convertido no picker; se veio do par data+hora também já vem coerced
    if time2 is not None and ts.dtype == "O":
        # Garantia extra caso série tenha vindo como objeto
        d = pd.to_datetime(df[time_col], errors="coerce", dayfirst=True).dt.strftime("%Y-%m-%d")
        h = pd.to_datetime(df[time2].astype(str), errors="coerce").dt.time.astype(str)
        ts = pd.to_datetime(d + " " + h, errors="coerce")

    temp = _clean_numeric_series(df[temp_col])
    temp = _final_sanity_trim(temp)

    out = pd.DataFrame({"timestamp": ts, "temperature": temp}).dropna(subset=["timestamp", "temperature"])

    # Fallback: se ficou vazio, tente outras colunas candidatas de temperatura
    if out.empty:
        # tenta outras 2 melhores candidatas de temperatura
        # Recalcular ranking
        ranking = []
        for c in df.columns:
            name_score = 1.0 if TEMP_NAME_PAT.search(c) else 0.0
            pct_num, median_val = _column_numeric_quality(df[c])
            plaus = 1.0 if (not math.isnan(median_val) and -50.0 <= median_val <= 100.0) else 0.0
            score = name_score * 2.0 + pct_num * 1.5 + plaus * 2.5
            ranking.append((score, c))
        ranking.sort(reverse=True)

        for _, c in ranking[1:3]:  # tenta as próximas duas
            t2 = _clean_numeric_series(df[c])
            t2 = _final_sanity_trim(t2)
            tmp = pd.DataFrame({"timestamp": ts, "temperature": t2}).dropna(subset=["timestamp", "temperature"])
            if not tmp.empty:
                out = tmp
                temp_col = c
                break

    if out.empty:
        raise HTTPException(
            status_code=400,
            detail=(
                "Não consegui gerar série de tempo/temperatura com os dados fornecidos. "
                f"Colunas lidas: {df.columns.tolist()}. "
                f"Tempo escolhido: {time_col}" + (f" + {time2}" if time2 else "") + f"; Temperatura escolhida: {temp_col}."
            )
        )

    # Ordena por tempo
    out = out.sort_values("timestamp")

    # Estatísticas
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

    data = [
        {"timestamp": row["timestamp"].isoformat(), "temperature": float(row["temperature"])}
        for _, row in out.iterrows()
    ]

    return {
        "time_key": "timestamp",
        "temp_key": "temperature",
        "data": data,
        "stats": stats,
    }
@app.get("/health")
async def health():
    return {"status": "ok"}