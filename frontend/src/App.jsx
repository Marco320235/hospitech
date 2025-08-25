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

export default function App() {
  const [files, setFiles] = useState([]);
  const [series, setSeries] = useState([]); // dados das planilhas
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hiddenKeys, setHiddenKeys] = useState([]); // controla quais linhas esconder
  const [dateRange, setDateRange] = useState({ start: "", end: "" }); // filtro por período

  const onFile = (e) => {
    const f = e.target.files ? Array.from(e.target.files).slice(0, 5) : [];
    setFiles(f);
  };

  const onUpload = async () => {
    if (files.length === 0) return;
    setLoading(true);
    setError("");
    setSeries([]);
    try {
      const results = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const form = new FormData();
        form.append("file", file);
        const res = await axios.post("/api/upload", form, {
          headers: { "Content-Type": "multipart/form-data" }
        });
        const { data: serie, stats } = res.data;
        const shaped = serie.map((d) => ({
          ...d,
          timeLabel: dayjs(d.timestamp).format("DD/MM HH:mm"),
          timestamp: d.timestamp
        }));
        results.push({
          id: i,
          name: file.name,
          color: COLORS[i % COLORS.length],
          data: shaped,
          stats
        });
      }
      setSeries(results);
    } catch (err) {
      console.error(err);
      const msg =
        err?.response?.data?.detail || "Falha no upload/processamento";
      setError(String(msg));
    } finally {
      setLoading(false);
    }
  };

  const onReset = () => {
    setFiles([]);
    setSeries([]);
    setError("");
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

  // estatísticas se houver apenas 1 série ativa
  const activeSeries = series.filter((s) => !hiddenKeys.includes(s.name));
  const showStats = activeSeries.length === 1 ? activeSeries[0].stats : null;

  // Exportar gráfico + estatísticas em PDF
  const exportPDF = async () => {
    const chartEl = document.getElementById("chart-section");
    if (!chartEl) return;

    const canvas = await html2canvas(chartEl, { scale: 2 });
    const imgData = canvas.toDataURL("image/png");

    const pdf = new jsPDF("landscape", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

    pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);

    if (showStats) {
      pdf.setFontSize(12);
      pdf.text(
        `Temperatura mínima: ${showStats.min.toFixed(2)} °C`,
        14,
        pdfHeight + 20
      );
      pdf.text(
        `Temperatura média: ${showStats.avg.toFixed(2)} °C`,
        14,
        pdfHeight + 30
      );
      pdf.text(
        `Temperatura máxima: ${showStats.max.toFixed(2)} °C`,
        14,
        pdfHeight + 40
      );
      pdf.text(
        `Início: ${dayjs(showStats.start).format("DD/MM/YYYY HH:mm")}`,
        14,
        pdfHeight + 50
      );
      pdf.text(
        `Fim: ${dayjs(showStats.end).format("DD/MM/YYYY HH:mm")}`,
        14,
        pdfHeight + 60
      );
    }

    pdf.save("grafico-temperatura.pdf");
  };

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
          <a href="#faq">FAQ</a>
          <a href="#analise" className="btn nav-cta">Começar</a>
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
          <ul className="hero-badges">


          </ul>
        </div>
      </section>

      {/* FEATURES */}
      <section className="panel features">
        <div className="feature">
          <div className="feature-icon">📈</div>
          <h3>Gráficos Profissionais</h3>
          <p>Visualize temperatura × tempo com múltiplas séries alinhadas por timestamp.</p>
        </div>
        <div className="feature">
          <div className="feature-icon">🧠</div>
          <h3>Estatísticas Automáticas</h3>
          <p>Mínimo, máximo, média e intervalo temporal detectados a partir da sua planilha.</p>
        </div>
        <div className="feature">
          <div className="feature-icon">🗂️</div>
          <h3>Multi-planilha</h3>
          <p>Compare até 5 arquivos ao mesmo tempo e oculte séries pelo legend.</p>
        </div>
        <div className="feature">
          <div className="feature-icon">📄</div>
          <h3>Exportação em PDF</h3>
          <p>Capture o gráfico e as estatísticas para documentação técnica e auditorias.</p>
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
            <button className="btn" onClick={onUpload} disabled={files.length === 0 || loading}>
              {loading ? "Processando..." : "Processar"}
            </button>
            <button className="btn secondary" onClick={onReset}>Limpar</button>
            {series.length > 0 && (
              <button className="btn" onClick={exportPDF}>Exportar PDF</button>
            )}
          </div>
        </div>

        {error && <div className="err">{error}</div>}
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

      {/* FAQ */}
      <section id="faq" className="panel faq">
        <h3>Dúvidas frequentes</h3>
        <details>
          <summary>Quais formatos são aceitos?</summary>
          <p>.xls, .xlsx e .csv exportados pelo HT-810 datalogger.</p>
        </details>
        <details>
          <summary>Posso comparar várias medições?</summary>
          <p>Sim, envie até 5 planilhas e use o legend para ocultar/exibir séries.</p>
        </details>
        <details>
          <summary>Como gero um relatório?</summary>
          <p>Após analisar, clique em “Exportar PDF” para baixar o gráfico com estatísticas.</p>
        </details>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        
        <div><b>Hospitech</b> — Engenharia Clínica</div>
        <div className="footer-note">© {new Date().getFullYear()} Hospitech. Todos os direitos reservados.</div>
      </footer>
    </div>
  );
}
