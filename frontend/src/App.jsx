import React, { useState, useMemo } from "react";
import axios from "axios";
import dayjs from "dayjs";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from "recharts";

// Paleta principal (coerente com a marca)
const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7"];

// Login fixo
const USER = "hospitech";
const PASS = "1234";

export default function App() {
  // --- LOGIN (persistente) ---
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem("auth") === "1";
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const handleLogin = (e) => {
    e.preventDefault();
    if (username === USER && password === PASS) {
      localStorage.setItem("auth", "1");
      setIsAuthenticated(true);
      setLoginError("");
    } else {
      setLoginError("Usuário ou senha incorretos");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("auth");
    setIsAuthenticated(false);
    setUsername("");
    setPassword("");
  };

  // --- ESTADOS DO APP ---
  const [files, setFiles] = useState([]);
  const [series, setSeries] = useState([]); // dados das planilhas
  const [loading, setLoading] = useState(false);
  const [uploadError, setUploadError] = useState(""); // <— separado do login
  const [hiddenKeys, setHiddenKeys] = useState([]); // controla quais linhas esconder
  const [dateRange, setDateRange] = useState({ start: "", end: "" }); // filtro por período

  const onFile = (e) => {
    const f = e.target.files ? Array.from(e.target.files).slice(0, 5) : [];
    setFiles(f);
  };

  const onUpload = async () => {
    if (files.length === 0) return;
    setLoading(true);
    setUploadError("");
    setSeries([]);
    try {
      const results = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const form = new FormData();
        form.append("file", file);

        // enviar período ao backend (opcional)
        if (dateRange.start) form.append("start", dateRange.start);
        if (dateRange.end) form.append("end", dateRange.end);

        const res = await axios.post("/api/upload", form, {
          headers: { "Content-Type": "multipart/form-data" }
        });

        // Agora a API devolve: data (original filtrada), stats e resampled (1H)
        const { data: serie, stats, resampled } = res.data;

        // pontos originais para o gráfico
        const shaped = serie.map((d) => ({
          ...d,
          timeLabel: dayjs(d.timestamp).format("DD/MM HH:mm"),
          timestamp: d.timestamp
        }));

        // série reamostrada do backend para as tabelas
        const shapedResampled = (resampled || []).map((d) => ({
          ...d,
          timeLabel: dayjs(d.timestamp).format("DD/MM/YYYY HH:mm"),
          timestamp: d.timestamp
        }));

        results.push({
          id: i,
          name: file.name,
          color: COLORS[i % COLORS.length],
          data: shaped,
          resampled: shapedResampled,
          stats
        });
      }
      setSeries(results);
    } catch (err) {
      console.error(err);
      const msg =
        err?.response?.data?.detail || "Falha no upload/processamento";
      setUploadError(String(msg));
    } finally {
      setLoading(false);
    }
  };

  const onReset = () => {
    setFiles([]);
    setSeries([]);
    setUploadError("");
    setHiddenKeys([]);
    setDateRange({ start: "", end: "" });
  };

  const toggleLine = (name) => {
    setHiddenKeys((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  };

  // mesclar timestamps para alinhar no gráfico
  const mergedData = useMemo(() => {
    const all = new Map();
    series.forEach((s) => {
      s.data.forEach((d) => {
        if (!all.has(d.timeLabel)) {
          all.set(d.timeLabel, { timeLabel: d.timeLabel, timestamp: d.timestamp });
        }
        all.get(d.timeLabel)[s.name] = d.temperature;
      });
    });

    let arr = Array.from(all.values());

    // aplicar filtro de período
    if (dateRange.start || dateRange.end) {
      arr = arr.filter((row) => {
        const t = dayjs(row.timestamp);
        const afterStart = dateRange.start
          ? t.isAfter(dayjs(dateRange.start)) || t.isSame(dayjs(dateRange.start))
          : true;
        const beforeEnd = dateRange.end
          ? t.isBefore(dayjs(dateRange.end)) || t.isSame(dayjs(dateRange.end))
          : true;
        return afterStart && beforeEnd;
      });
    }

    return arr;
  }, [series, dateRange]);

  // Tabelas por planilha usando a AMOSTRAGEM DO BACKEND (1h)
  const resampledBySeries = useMemo(() => {
    const map = {};
    const hasStart = !!dateRange.start;
    const hasEnd = !!dateRange.end;
    const start = hasStart ? dayjs(dateRange.start) : null;
    const end = hasEnd ? dayjs(dateRange.end) : null;

    series.forEach((s) => {
      const base = s.resampled || [];
      const rows = base.filter((r) => {
        const t = dayjs(r.timestamp);
        const okStart = hasStart ? (t.isAfter(start) || t.isSame(start)) : true;
        const okEnd = hasEnd ? (t.isBefore(end) || t.isSame(end)) : true;
        return okStart && okEnd;
      });
      map[s.name] = rows;
    });
    return map;
  }, [series, dateRange]);

  // estatísticas se houver apenas 1 série ativa
  const activeSeries = series.filter((s) => !hiddenKeys.includes(s.name));
  const showStats = activeSeries.length === 1 ? activeSeries[0].stats : null;

  // Exportar gráfico + estatísticas + TABELAS em PDF
  const exportPDF = async () => {
    const chartEl = document.getElementById("chart-section");
    const tablesEl = document.getElementById("tables-section");

    if (!chartEl) return;

    const pdf = new jsPDF("landscape", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    // --- 1) Adiciona o gráfico ---
    const chartCanvas = await html2canvas(chartEl, { scale: 2 });
    const chartImgData = chartCanvas.toDataURL("image/png");
    let y = 10;
    let chartHeight = (chartCanvas.height * pdfWidth) / chartCanvas.width;
    pdf.addImage(chartImgData, "PNG", 10, y, pdfWidth - 20, chartHeight);

    y += chartHeight + 10; // espaço depois do gráfico

    // Estatísticas (se houver)
    if (showStats) {
      pdf.setFontSize(12);
      const statsY = y;
      pdf.text(`Temperatura mínima: ${showStats.min.toFixed(2)} °C`, 10, statsY);
      pdf.text(`Temperatura média: ${showStats.avg.toFixed(2)} °C`, 10, statsY + 8);
      pdf.text(`Temperatura máxima: ${showStats.max.toFixed(2)} °C`, 10, statsY + 16);
      pdf.text(`Início: ${dayjs(showStats.start).format("DD/MM/YYYY HH:mm")}`, 10, statsY + 24);
      pdf.text(`Fim: ${dayjs(showStats.end).format("DD/MM/YYYY HH:mm")}`, 10, statsY + 32);
      y += 42;
    }

    // --- 2) Adiciona todas as tabelas ---
    if (tablesEl) {
      const tables = tablesEl.querySelectorAll(".table-wrap");

      for (let i = 0; i < tables.length; i++) {
        if (tables[i].style.display === "none") continue;

        const canvas = await html2canvas(tables[i], { scale: 2 });
        const imgData = canvas.toDataURL("image/png");
        const imgHeight = (canvas.height * pdfWidth) / canvas.width;

        if (y + imgHeight > pageHeight - 10) {
          pdf.addPage();
          y = 10;
        }

        pdf.addImage(imgData, "PNG", 10, y, pdfWidth - 20, imgHeight);
        y += imgHeight + 10;
      }
    }

    pdf.save("relatorio.pdf");
  };

  // ---------- TELA DE LOGIN ----------
  if (!isAuthenticated) {
    return (
      <div className="login-page">
  <div className="login-card">
    <img src="/logo.png" alt="Logo" className="login-logo" />
    <h2>Bem-vindo</h2>
    <p>Entre com suas credenciais para continuar</p>
    <form className="login-form" onSubmit={handleLogin}>
      <input
        type="text"
        placeholder="Usuário"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        placeholder="Senha"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {loginError && <div className="login-error">{loginError}</div>}
      <button className="login-btn" type="submit">Entrar</button>
    </form>
  </div>
</div>

    );
  }

  // ---------- APP AUTENTICADO ----------
  return (
    <div className="app">
      {/* HEADER */}
      <header className="site-header">
        <div className="brand">
          <img src="/logo.png" alt="Hospitech Logo" className="logo" />
          <div className="brand-text">
            <h1>Hospitech</h1>
            <span>Engenharia Clínica</span>
          </div>
        </div>
        <nav className="nav">
          <a href="#inicio">Início</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#analise">Análise</a>
          <a href="#analise" className="btn nav-cta">Começar</a>
          <button type="button" className="btn secondary" onClick={handleLogout} style={{ marginLeft: 12 }}>
            Sair
          </button>
        </nav>
      </header>

      {/* HERO */}
      <section id="inicio" className="hero">
        <div className="hero-content">
          <h2>Análise inteligente para o HT-810 Datalogger</h2>
          <p>
            Faça upload da planilha do seu datalogger, e nós cuidamos do resto:
            unificação de séries, filtros por período, estatísticas automáticas e
            gráfico profissional, prontos para relatório em PDF.
          </p>
          <div className="hero-actions">
            <a href="#analise" className="btn hero-btn">Enviar planilhas</a>
            <a href="#como-funciona" className="btn secondary hero-btn">Entender processo</a>
          </div>
          <ul className="hero-badges"></ul>
        </div>
      </section>

      {/* COMO FUNCIONA */}
      <section id="como-funciona" className="panel howto">
        <h3>Como funciona</h3>
        <ol className="steps">
          <li><b></b> Exporte a planilha do HT-810 (.xls, .xlsx ou .csv).</li>
          <li><b></b> Faça o upload abaixo (até 5 arquivos por vez).</li>
          <li><b></b> A plataforma alinha os dados e calcula estatísticas.</li>
          <li><b></b> Filtre por período, esconda séries e gere o PDF.</li>
        </ol>
      </section>

      {/* ÁREA DE ANÁLISE */}
      <section id="analise" className="panel uploader">
        <div className="uploader-header">
          <div className="uploader-title">
            <h3>Analisar arquivos HT-810</h3>
            {series.length > 0 ? (
              <span className="badge">{series.length} planilha(s)</span>
            ) : null}
          </div>
          <p className="uploader-sub">Selecione até 5 planilhas do datalogger para comparar.</p>
        </div>

        <div className="dropzone">
          <div><b>Selecione até 5 planilhas</b> (.xls, .xlsx ou .csv)</div>
          <div style={{ marginTop: 6 }}>
            {files.length > 0 ? files.map((f) => f.name).join(", ") : "Nenhum arquivo selecionado"}
          </div>
        </div>

        <div className="controls">
          <label className="fileinput">
            <input type="file" multiple onChange={onFile} />
            <span>Escolher arquivos</span>
          </label>

          <div className="btn-row">
            <button type="button" className="btn" onClick={onUpload} disabled={files.length === 0 || loading}>
              {loading ? "Processando..." : "Processar"}
            </button>
            <button type="button" className="btn secondary" onClick={onReset}>Limpar</button>
            {series.length > 0 && (
              <button type="button" className="btn" onClick={exportPDF}>Exportar PDF</button>
            )}
          </div>
        </div>

        {uploadError && <div className="err">{uploadError}</div>}
      </section>

      {/* FILTRO */}
      {series.length > 0 && (
        <section className="panel" style={{ marginTop: 12 }}>
          <div className="panel-title">Filtrar por período</div>
          <div className="period-controls">
            <label>
              Início:{" "}
              <input
                type="datetime-local"
                value={dateRange.start}
                onChange={(e) => setDateRange((r) => ({ ...r, start: e.target.value }))}
              />
            </label>
            <label>
              Fim:{" "}
              <input
                type="datetime-local"
                value={dateRange.end}
                onChange={(e) => setDateRange((r) => ({ ...r, end: e.target.value }))}
              />
            </label>
          </div>
        </section>
      )}

      {/* ESTATÍSTICAS */}
      {showStats && (
        <section className="statgrid">
          <div className="stat"><div>Mín</div><b>{showStats.min?.toFixed(2)} °C</b></div>
          <div className="stat"><div>Méd</div><b>{showStats.avg?.toFixed(2)} °C</b></div>
          <div className="stat"><div>Máx</div><b>{showStats.max?.toFixed(2)} °C</b></div>
          <div className="stat"><div>Início</div><b>{dayjs(showStats.start).format("DD/MM/YYYY HH:mm")}</b></div>
          <div className="stat"><div>Fim</div><b>{dayjs(showStats.end).format("DD/MM/YYYY HH:mm")}</b></div>
        </section>
      )}

      {/* GRÁFICO */}
      {series.length > 0 && (
        <section className="panel chart-wrap" id="chart-section">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={mergedData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="timeLabel" minTickGap={24} />
              <YAxis width={60} />
              <Tooltip
                contentStyle={{
                  background: "rgba(31,42,68,0.95)",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  boxShadow: "0 10px 24px rgba(0,0,0,.25)"
                }}
                labelStyle={{ color: "#94a3b8" }}
              />
              <Legend onClick={(e) => toggleLine(e.value)} />
              {series.map((s) => (
                <Line
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  name={s.name}
                  stroke={s.color}
                  dot={false}
                  strokeWidth={2}
                  hide={hiddenKeys.includes(s.name)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* TABELAS */}
      {series.length > 0 && (
        <section className="panel" id="tables-section">
          <div className="panel-title">Tabelas (amostragem a cada 1 hora)</div>

          {series.map((s) => {
            const hidden = hiddenKeys.includes(s.name);
            const rows = resampledBySeries[s.name] || [];
            return (
              <div
                key={s.name}
                className="table-wrap"
                style={{ display: hidden ? "none" : "block", marginTop: 12 }}
              >
                <div className="uploader-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    display: "inline-block", width: 10, height: 10, borderRadius: 999, background: s.color
                  }} />
                  <h4 style={{ margin: 0 }}>{s.name}</h4>
                  <span className="badge">{rows.length} linha(s)</span>
                </div>

                <div className="table-scroll" style={{ overflowX: "auto", marginTop: 8 }}>
                  <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #e5e7eb" }}>Horário</th>
                        <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #e5e7eb" }}>Temperatura (°C)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, idx) => (
                        <tr key={idx}>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f5f9" }}>
                            {dayjs(r.timestamp).format("DD/MM/YYYY HH:mm")}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f5f9" }}>
                            {r.temperature.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={2} style={{ padding: "8px", color: "#64748b" }}>
                            Sem dados para o período selecionado.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* FOOTER */}
      <footer className="footer">
        <div><b>Hospitech</b> — Engenharia Clínica</div>
        <div className="footer-note">© {new Date().getFullYear()} Hospitech. Todos os direitos reservados.</div>
      </footer>
    </div>
  );
}
