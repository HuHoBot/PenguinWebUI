import { useEffect, useState } from 'react';
import { readEditorLocation, type EditorLocation } from './api';
import { ConfigEditor } from './ConfigEditor';
import { Icon, type IconName } from './Icon';
import { CommandConsole, QrPanel, UpdatePanel } from './ManagementPanels';
import { useEditor, type EditorSession } from './useEditor';

const navigation: { id: string; label: string; icon: IconName; subtitle: string }[] = [
  { id: 'overview', label: '服务器概览', icon: 'dashboard', subtitle: '实时状态与服务器信息' },
  { id: 'configuration', label: '配置管理', icon: 'settings', subtitle: '全局设置与按群命令覆盖' },
  { id: 'console', label: '命令控制台', icon: 'terminal', subtitle: '以管理员身份执行服务器命令' },
  { id: 'qr', label: 'QQ扫码绑定', icon: 'qr', subtitle: '机器人扫码流程与实时二维码' },
  { id: 'updates', label: '版本更新', icon: 'update', subtitle: '插件版本与远程更新检查' },
];

function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function ConnectionGuide() {
  return <section className="panel welcome-panel" id="connection-guide" aria-labelledby="connection-guide-title">
    <div className="authorization-icon"><Icon name="link" size={34} /></div>
    <span className="eyebrow">ONE-USE VERIFICATION</span>
    <h2 id="connection-guide-title">通过一次性验证码连接服务器</h2>
    <p>在需要管理的服务器控制台，或由有权限的游戏玩家执行：</p>
    <code className="standalone-command" id="create-channel-command">/huhobot webui</code>
    <ol className="connection-steps">
      <li><span>01</span><div><strong>打开服务器生成的完整链接</strong><p>页面会自动建立临时网页会话，并显示一次性验证码。</p></div></li>
      <li><span>02</span><div><strong>核对服务器并确认此网页会话</strong><p>在目标服务器执行页面显示的 <code>/huhobot webui &lt;验证码&gt;</code> 命令。验证码 5 分钟内有效，只能使用一次。</p></div></li>
      <li><span>03</span><div><strong>收到服务器确认后开始管理</strong><p>实时状态、配置、命令控制台与机器人管理仅在服务器确认后开放。此首页不会自动创建或选择服务器。</p></div></li>
    </ol>
    <div className="security-note"><Icon name="shield" size={20} /><span>验证码仅用于确认此网页会话与目标服务器。请勿转发完整编辑链接或一次性验证码；结束会话后需从服务器重新获取链接。</span></div>
  </section>;
}

function PendingAuthorization({ session, now }: { session: EditorSession; now: number }) {
  const [copyState, setCopyState] = useState<string | null>(null);
  const channel = session.channel!;
  const codeValid = !!channel.code && (channel.codeExpiresAt ?? 0) > now;
  const command = channel.code ? `/huhobot webui ${channel.code}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopyState('确认命令已复制。请在 5 分钟内粘贴到目标服务器控制台，或由有权限的游戏玩家执行；一次性验证码只能使用一次。'); }
    catch { setCopyState('浏览器未允许读取剪贴板，请手动选中并复制下方命令。'); }
  };
  useEffect(() => { setCopyState(null); }, [channel.code]);
  return <section className="panel authorization-panel" aria-labelledby="authorization-title">
    <div className="authorization-icon"><Icon name="shield" size={36} /></div>
    <span className="eyebrow">SERVER CONFIRMATION REQUIRED</span>
    <h2 id="authorization-title">最后一步：在服务器确认此网页会话</h2>
    <p className="authorization-description">页面已自动加入频道，但尚未获得管理权限。核对目标服务器后，在该服务器执行下面的命令。一次性验证码与此网页会话绑定，5 分钟内有效且只能使用一次；收到服务器确认后才会开放管理面板。</p>
    <div className="identity-grid"><div><span>确认范围</span><strong>此网页会话</strong><small>仅用于当前浏览器的临时配对上下文</small></div><div><span>授权目标服务器</span><strong id="pending-server">{channel.server.name}</strong><small>{channel.server.platform} · v{channel.server.version}</small></div></div>
    <div className={`confirmation-code ${codeValid ? '' : 'code-expired'}`}><div><span>在目标服务器执行</span><code id="confirmation-command" data-verification-code={channel.code}>{command || '等待一次性验证码'}</code></div><button id="copy-confirmation-command" type="button" className="button button-secondary" disabled={!codeValid} onClick={() => void copy()}><Icon name="copy" size={17} />复制命令</button></div>
    <div className="code-meta"><span className={`badge ${codeValid ? 'badge-amber' : 'badge-red'}`}>{codeValid ? `验证码剩余 ${countdown(channel.codeExpiresAt!, now)}` : '验证码已过期或不可用'}</span><span className="muted">频道剩余 {countdown(channel.expiresAt, now)}</span></div>
    {copyState && <div className="inline-info" role="status">{copyState}</div>}
    {!codeValid && <div className="alert alert-warning"><div><strong>请获取新的一次性验证码</strong><p>旧验证码已失效。获取新码后，请在服务器执行新显示的命令。</p></div><button id="refresh-verification-code" type="button" className="button button-secondary" disabled={session.channelLoading} onClick={() => void session.reloadChannel()}>{session.channelLoading ? '正在获取…' : '获取新验证码'}</button></div>}
    <div className="authorization-wait" id="authorization-status" role="status"><span className="status-dot dot-amber" />{session.connection === 'connected' ? '实时通道已连接，正在等待服务器确认' : '正在连接实时通道，授权状态以服务器反馈为准'}</div>
    {!channel.serverOnline && <p className="muted">服务器目前未连接到频道；请先检查服务器上的插件连接。</p>}
  </section>;
}

function Overview({ session, now }: { session: EditorSession; now: number }) {
  const status = session.status;
  const server = status ?? session.channel!.server;
  const players = status?.online ?? [];
  const groups = status?.groups ?? [];
  return <div className="overview-content"><div className="overview-hero"><div><span className="eyebrow">LIVE SERVER WORKSPACE</span><h2>{server.name}</h2><p>此网页会话已由服务器确认。实时数据来自目标服务器，不会自动执行任何管理操作。</p></div><div className="hero-status"><span className={`status-dot ${session.canSend ? 'dot-green' : 'dot-amber'}`} /><span>{session.canSend ? '实时管理已就绪' : '等待服务器与实时通道连接'}</span></div></div><div className="stat-grid"><article className="stat-card"><span className="stat-icon violet"><Icon name="server" /></span><span className="stat-label">服务端平台</span><strong>{server.platform || '—'}</strong><small>插件版本 {server.version || '—'}</small></article><article className="stat-card"><span className="stat-icon cyan"><Icon name="link" /></span><span className="stat-label">机器人连接状态</span><strong>{status?.connection || '等待快照'}</strong><small>服务器通道 {session.channel!.serverOnline ? '在线' : '离线'}</small></article><article className="stat-card"><span className="stat-icon blue"><Icon name="users" /></span><span className="stat-label">在线玩家</span><strong>{status ? players.length : '—'}</strong><small>来自服务器实时状态</small></article><article className="stat-card"><span className="stat-icon amber"><Icon name="groups" /></span><span className="stat-label">已连接群组</span><strong>{status ? groups.length : '—'}</strong><small>可按群覆盖命令配置</small></article></div><div className="overview-grid"><section className="panel" aria-labelledby="players-title"><div className="panel-heading compact"><div><h2 id="players-title">在线玩家</h2><p>服务器上当前在线的玩家列表</p></div><span className="badge badge-neutral">{status ? players.length : '—'}</span></div>{players.length ? <ul className="entity-list">{players.map((player, index) => <li key={`${player}:${index}`}><span className="avatar avatar-small">{player.slice(0, 1).toLocaleUpperCase()}</span><span>{player}</span><span className="status-dot dot-green" /></li>)}</ul> : <div className="empty-state small"><Icon name="users" size={30} /><p>{status ? '当前没有在线玩家' : '正在等待服务器状态快照'}</p></div>}</section><section className="panel" aria-labelledby="groups-title"><div className="panel-heading compact"><div><h2 id="groups-title">已连接群组</h2><p>按群配置的范围来自此列表</p></div><span className="badge badge-neutral">{status ? groups.length : '—'}</span></div>{groups.length ? <ul className="entity-list">{groups.map((group) => <li key={group}><span className="group-icon"><Icon name="groups" size={17} /></span><span>{status?.groupNames?.[group] || group}<small className="muted">{status?.groupNames?.[group] ? group : ''}</small></span><span className="badge badge-neutral">群组</span></li>)}</ul> : <div className="empty-state small"><Icon name="groups" size={30} /><p>{status ? '当前没有已连接群组' : '正在等待服务器状态快照'}</p></div>}</section></div><section className="panel session-panel"><div><Icon name="shield" size={22} /><div><h3>临时授权会话</h3><p>频道关闭、结束此网页会话或达到有效期后，管理权限将失效。服务器离线期间禁止发送请求。</p></div></div><span className="badge badge-neutral">剩余 {countdown(session.channel!.expiresAt, now)}</span></section></div>;
}

export default function App() {
  const [location] = useState<EditorLocation>(readEditorLocation);
  const session = useEditor(location);
  const [page, setPage] = useState('overview');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const authorized = session.sessionReady && session.channel?.state === 'authorized';
  const currentPage = navigation.find((item) => item.id === page)!;
  const stateLabel = !location.channelId ? '尚未连接服务器' : session.sessionLoading ? '正在准备网页会话' : !session.sessionReady ? '网页会话未就绪' : session.channelLoading && !session.channel ? '加入频道中' : session.channel?.state === 'closed' ? '频道已关闭' : session.channel?.state === 'pending' ? '等待服务器确认' : authorized ? session.canSend ? '实时在线' : '暂时离线' : '尚未加入频道';
  return <div className="app-shell" data-authorized={authorized}>
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <aside className="sidebar">
      <a href="/" className="brand" aria-label="HuHoBot WebUI 首页"><span className="brand-mark"><Icon name="server" size={25} /></span><span>HuHoBot<span className="brand-subtitle">SERVER WORKSPACE</span></span></a>
      <div className="sidebar-heading">管理工作区</div>
      <nav className="desktop-navigation" aria-label="主要导航">{navigation.map((item) => <button key={item.id} id={`nav-${item.id}`} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} disabled={!authorized && item.id !== 'overview'} onClick={() => setPage(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{page === item.id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-status"><span className={`status-dot ${session.canSend ? 'dot-green' : 'dot-amber'}`} /><span>{stateLabel}</span></div><p>由服务器确认此网页会话<br />按频道隔离的临时管理权限</p><span className="sidebar-version">HuHoBot · WebUI</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-location"><Icon name={currentPage.icon} size={18} /><span>工作区</span><span className="breadcrumb-separator">/</span><strong>{authorized ? currentPage.label : '安全连接'}</strong></div>
        <div className="session-controls"><span id="workspace-state" className={`badge ${session.canSend ? 'badge-green' : 'badge-neutral'}`}><span className={`status-dot ${session.canSend ? 'dot-green' : 'dot-amber'}`} />{stateLabel}</span>{!session.sessionLoading && <button id="end-session" type="button" className="button button-quiet" disabled={session.sessionEnding} onClick={() => void session.endSession()} aria-label="结束此网页会话"><Icon name="end" size={18} /><span>{session.sessionEnding ? '正在结束…' : '结束会话'}</span></button>}</div>
      </header>
      <nav className="mobile-navigation" aria-label="移动端导航">{navigation.map((item) => <button key={item.id} type="button" className={page === item.id ? 'active' : ''} disabled={!authorized && item.id !== 'overview'} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} size={19} /><span>{item.label}</span></button>)}</nav>
      <main id="main-content" className="main-content">
        <div className="page-heading"><div><span className="eyebrow">HUHOBOT MANAGEMENT</span><h1>{authorized ? currentPage.label : '连接你的服务器'}</h1><p>{authorized ? currentPage.subtitle : '打开链接，获取一次性验证码，在目标服务器确认此网页会话。'}</p></div>{session.channel && session.channel.state !== 'closed' && <div className="channel-expiry"><Icon name="link" size={15} /><span>频道有效期 {countdown(session.channel.expiresAt, now)}</span></div>}</div>
        {session.notice && <div className="alert alert-warning" role="alert"><div>{session.notice}</div><button type="button" className="text-button" onClick={session.dismissNotice}>关闭提示</button></div>}
        {session.accessError && <div className="alert alert-error" role="alert"><div>{session.accessError}</div>{session.sessionReady && location.channelId && !location.error && session.channel?.state !== 'closed' && <button type="button" className="button button-secondary" disabled={session.channelLoading} onClick={() => void session.reloadChannel()}>重试加入</button>}</div>}
        {!location.channelId ? <ConnectionGuide /> : session.sessionLoading ? <section className="panel loading-panel" role="status"><span className="loader" /><p>正在建立临时网页会话…</p></section> : !session.sessionReady ? <section className="panel welcome-panel"><div className="authorization-icon closed-icon"><Icon name="link" size={34} /></div><h2>此网页会话已结束或未能建立</h2><p>请在服务器重新执行 <code>/huhobot webui</code>，并打开新生成的完整编辑链接。</p><p>未收到确认的操作可能已经执行，请先在服务器核对；页面不会自动重试。</p></section> : !session.channel ? <section className="panel loading-panel" role="status">{session.channelLoading ? <><span className="loader" /><p>正在验证链接并获取一次性验证码…</p></> : <><Icon name="shield" size={36} /><p>没有可访问的编辑频道。请检查上方错误，或从服务器重新获取完整链接。</p></>}</section> : session.channel.state === 'closed' ? <section className="panel welcome-panel"><div className="authorization-icon closed-icon"><Icon name="link" size={34} /></div><h2>编辑频道已关闭或过期</h2><p>{session.channel.reason || '本次管理授权已失效，敏感配置与命令记录已从页面清除。'}</p><p>请在服务器重新执行 <code>/huhobot webui</code> 并打开新的编辑链接。</p></section> : <>
          {(session.connection !== 'connected' || !session.channel.serverOnline) && <div className="alert alert-warning" role="status"><div><strong>{session.connection !== 'connected' ? session.connection === 'failed' ? '实时通道重连已停止' : '实时通道正在连接或重连' : '服务器已离线'}</strong><p>{session.connection !== 'connected' ? '页面可能显示最后收到的状态；所有管理请求已禁用。未收到响应的操作不会自动重试。' : '此网页会话仍有效，但目标服务器未连接。以下数据为最后快照，请等待服务器重新上线。'}</p></div>{session.connection === 'failed' && <button type="button" className="button button-secondary" onClick={session.reconnect}>手动重新连接</button>}</div>}
          {session.channel.state === 'pending' ? <PendingAuthorization session={session} now={now} /> : <div className="management-pages" id="management-pages"><div hidden={page !== 'overview'}><Overview session={session} now={now} /></div><div hidden={page !== 'configuration'}><ConfigEditor session={session} /></div><div hidden={page !== 'console'}><CommandConsole session={session} /></div><div hidden={page !== 'qr'}><QrPanel session={session} /></div><div hidden={page !== 'updates'}><UpdatePanel session={session} /></div></div>}
        </>}
      </main>
      <footer className="workspace-footer"><span>HuHoBot WebUI</span><span>真实服务器状态 · 临时授权 · 不重放命令</span></footer>
    </div>
  </div>;
}
