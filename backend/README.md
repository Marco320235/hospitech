# Backend (FastAPI)

## Passos (Windows CMD)

```bat
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

A API ouvirá em `http://127.0.0.1:8000`. Endpoint: `POST /api/upload` (multipart/form-data, campo `file`).

Aceita `.xls`, `.xlsx` e `.csv`. Para `.xls`, garanta que `xlrd` esteja instalado (já está no requirements).
