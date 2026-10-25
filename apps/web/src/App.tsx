import { ServiceHealth } from './components/ServiceHealth.js';
import './styles.css';

export default function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CentrAlign Operator home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>CentrAlign <b>Operator</b></span></a>
        <span className="environment-label">LOCAL DEVELOPMENT</span>
      </header>
      <main>
        <div className="intro">
          <span className="phase-badge"><span aria-hidden="true">02</span> Company context & tool layer</span>
          <h1>Verified work starts<br />with a reliable foundation.</h1>
          <p className="description">An autonomous enterprise operator designed to complete verified business work.</p>
        </div>
        <div className="dashboard-grid">
          <ServiceHealth />
          <section className="scope-card" aria-labelledby="scope-title">
            <p className="eyebrow">CURRENT DEVELOPMENT PHASE</p>
            <h2 id="scope-title">Phase 2 / 5</h2>
            <p>Deterministic server tools for the future runtime.</p>
            <ul className="foundation-list">
              <li><span aria-hidden="true">01</span><div><strong>Company context</strong><p>Indexed fictional sources with traceable excerpts.</p></div></li>
              <li><span aria-hidden="true">02</span><div><strong>Controlled local tools</strong><p>Typed writes, permissions, and idempotency.</p></div></li>
              <li><span aria-hidden="true">03</span><div><strong>Sandbox communication</strong><p>Exact approval required for the local outbox.</p></div></li>
            </ul>
          </section>
        </div>
        <aside className="boundary-note"><span className="note-icon" aria-hidden="true">i</span><div><strong>Server tools only</strong><p>Autonomous planning, task execution, real email delivery, approval interfaces, and independent business verification are not implemented yet. This dashboard displays live service health; tools run through trusted server modules.</p></div></aside>
      </main>
      <footer><span>CentrAlign Operator</span><span>Goal → Execute → Verify · Planned execution loop</span></footer>
    </div>
  );
}
