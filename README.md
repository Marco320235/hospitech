# HT-810 Temperature Dashboard

Projeto completo (backend FastAPI + frontend React) para fazer upload de planilha (.xls/.xlsx/.csv) e gerar gráfico Temperatura × Tempo, com estatísticas básicas.

## Como rodar (Windows CMD)

1) **Backend**  
```bat
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

2) **Frontend** (em outro terminal)  
```bat
cd frontend
npm install
npm run dev
```

Acesse: http://localhost:5173

Se precisar usar Linux/macOS, ajuste o comando de ativação do venv:
```bash
source .venv/bin/activate
```

Sem Tailwind: o CSS está em `frontend/src/styles.css`.
