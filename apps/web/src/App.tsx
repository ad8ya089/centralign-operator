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
          <span className="phase-badge"><span aria-hidden="true">01</span> Foundation & system contracts</span>
          <h1>Verified work starts<br />with a reliable foundation.</h1>
          <p className="description">An autonomous enterprise operator designed to complete verified business work.</p>
        </div>
        <div className="dashboard-grid">
          <ServiceHealth />
          <section className="scope-card" aria-labelledby="scope-title">
            <p className="eyebrow">CURRENT DEVELOPMENT PHASE</p>
            <h2 id="scope-title">Phase 1 / 5</h2>
            <p>The foundation for a durable, auditable operator.</p>
            <ul className="foundation-list">
              <li><span aria-hidden="true">01</span><div><strong>Shared contracts</strong><p>Typed records, validation, and state transitions.</p></div></li>
              <li><span aria-hidden="true">02</span><div><strong>Local persistence</strong><p>Versioned SQLite schema and event protections.</p></div></li>
              <li><span aria-hidden="true">03</span><div><strong>Connected dashboard</strong><p>Live API and database health checks.</p></div></li>
            </ul>
          </section>
        </div>
        <aside className="boundary-note"><span className="note-icon" aria-hidden="true">i</span><div><strong>Foundation only</strong><p>Autonomous task execution and integrations are not implemented yet. Planning, company context, approvals, email, and independent verification arrive in later phases.</p></div></aside>
      </main>
      <footer><span>CentrAlign Operator</span><span>Goal → Execute → Verify · Planned execution loop</span></footer>
    </div>
  );
}
