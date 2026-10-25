import { useCallback, useEffect, useState } from 'react';
import { Workspace } from './components/Workspace.js';
import { RunDetail } from './components/RunDetail.js';
import { Icon } from './components/ui.js';
import './styles.css';
import './console.css';

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const change = () => setPath(window.location.pathname); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  const navigate = useCallback((next: string) => { window.history.pushState({}, '', next); setPath(window.location.pathname); window.scrollTo(0, 0); }, []);
  let id: string | null = null; const match = /^\/runs\/([^/]+)\/?$/.exec(path);
  try { id = match?.[1] ? decodeURIComponent(match[1]) : null; } catch { id = null; }
  useEffect(() => { document.title = `${id ? 'Run workspace' : 'Workspace'} · CentrAlign Operator`; }, [id]);
  useEffect(() => { document.getElementById('workspace-main')?.focus({ preventScroll: true }); }, [path]);
  return <div className="console-shell"><a className="skip-link" href="#workspace-main">Skip to workspace</a><aside className="side-panel"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }} aria-label="CentrAlign Operator home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>CentrAlign<small>OPERATOR</small></span></a><div className="workspace-label">OPERATIONS</div><nav aria-label="Main navigation"><a className="nav-item selected" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}><Icon name="grid" /><span>Workspace</span></a><a className="nav-item" href="/#new-request" onClick={(event) => { event.preventDefault(); navigate('/'); requestAnimationFrame(() => document.getElementById('objective')?.focus()); }}><Icon name="plus" /><span>New request</span></a></nav><div className="side-bottom"><div className="local-environment"><span className="live-dot" /><span>Local prototype</span></div><p>Human decisions.<br />Verified outcomes.</p><span className="version-label">PHASE 04 / 05</span></div></aside><div className="console-main"><header className="console-topbar"><div className="breadcrumbs"><span>Workspace</span>{id && <><Icon name="chevron" size={13} /><strong>Run detail</strong></>}</div><div className="topbar-meta"><span className="sandbox-badge">Sandbox email</span><span className="avatar" aria-label="Local user, not authenticated">LO</span></div></header><main id="workspace-main" tabIndex={-1}>{path === '/' ? <Workspace navigate={navigate} /> : id ? <RunDetail key={id} id={id} navigate={navigate} /> : <section className="panel empty"><h1>Run link missing or invalid</h1><p>Return to the workspace and select a persisted run.</p><button className="button primary" onClick={() => navigate('/')}>Open workspace</button></section>}</main><footer className="console-footer"><span>CentrAlign Operator</span><span>Plan · Execute · Verify</span></footer></div></div>;
}
