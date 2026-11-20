import { useState } from 'react';
import type { QrState, UpdateState } from '../shared/protocol';
import { errorText } from './api';
import { Icon } from './Icon';
import type { EditorSession } from './useEditor';

interface HistoryEntry { id: string; command: string; at: number; output: string; error: boolean }

export function CommandConsole({ session }: { session: EditorSession }) {
  const [command, setCommand] = useState('');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const execute = async () => {
    if (!confirmation || busy) return;
    const submitted = confirmation;
    setConfirmation(null);
    setBusy(true);
    setFeedback(null);
    let output: string;
    let failed = false;
    try {
      const result = await session.request('command.execute', { command: submitted });
      if (typeof result !== 'object' || result === null || !('output' in result) || typeof result.output !== 'string') throw new Error('服务器没有返回有效的命令输出。请在服务器核对，勿直接重复执行。');
      output = result.output;
    } catch (error) { output = errorText(error); failed = true; }
    if (output.length > 65_536) output = output.slice(0, 65_536) + '\n[页面仅保留前 64 KiB 输出]';
    setHistory((entries) => [{ id: crypto.randomUUID(), command: submitted, at: Date.now(), output, error: failed }, ...entries].slice(0, 20));
    setBusy(false);
    setFeedback(failed ? '执行未得到成功确认。请查看下方错误，先核对服务器再决定是否重试。' : '服务器已返回本次命令的执行结果。');
  };
  return <section className="panel" aria-labelledby="console-title">
    <div className="panel-heading"><div><span className="eyebrow">SERVER CONSOLE</span><h2 id="console-title">服务器命令</h2><p>以服务器控制台身份执行原生命令。此入口具有不受限制的管理员权限。</p></div><span className="badge badge-amber"><Icon name="shield" size={14} />高权限操作</span></div>
    <div className="alert alert-warning"><strong>请确认命令来源与影响</strong><p>命令可能修改玩家权限、世界或服务器状态。每次执行都需显式确认；断线或超时后绝不会自动重放。</p></div>
    <label htmlFor="server-command">控制台命令</label>
    <textarea id="server-command" className="command-input" rows={4} value={command} maxLength={4096} disabled={busy || !session.canSend} onChange={(event) => { setCommand(event.target.value); setConfirmation(null); setFeedback(null); }} placeholder="输入服务器命令，例如 list（不需要前导 /）" spellCheck={false} autoComplete="off" />
    <div className="console-action"><span className="muted">仅手动执行，不会自动执行或重试。最多保留本页最近 20 条记录。</span><button type="button" className="button button-primary" disabled={!session.canSend || busy || !command.trim()} onClick={() => { setConfirmation(command.trim()); setFeedback(null); }}><Icon name="terminal" size={17} />{busy ? '等待服务器响应…' : '执行命令'}</button></div>
    {confirmation && <div className="confirmation" role="alert"><strong>确认以服务器管理员身份执行？</strong><pre>{confirmation}</pre><p>请核对上方完整命令。这不是预览，点击确认将发送真实控制台请求。</p><div className="button-row"><button type="button" className="button button-secondary" onClick={() => setConfirmation(null)}>取消</button><button type="button" className="button button-danger" disabled={!session.canSend || busy} onClick={() => void execute()}>确认执行</button></div></div>}
    {feedback && <div className="inline-info" role="status">{feedback}</div>}
    <div className="history-heading"><h3>命令记录</h3><button type="button" className="text-button" disabled={!history.length || busy} onClick={() => { setHistory([]); setFeedback(null); }}>清空本页记录</button></div>
    {history.length ? <div className="command-history" aria-live="polite">{history.map((entry) => <article key={entry.id} className={`console-entry ${entry.error ? 'console-entry-error' : ''}`}><div className="console-entry-header"><span>{entry.error ? '未确认成功' : '已返回结果'}</span><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString('zh-CN')}</time></div><pre className="console-command">&gt; {entry.command}</pre><pre>{entry.output || '命令已返回，但未产生文本输出。'}</pre></article>)}</div> : <div className="empty-state small"><Icon name="terminal" size={28} /><p>尚未执行命令</p><span>响应将在这里以纯文本显示。</span></div>}
  </section>;
}

function localPng(qr: QrState | null): string | null {
  if (!qr?.qrImageBase64 || qr.qrImageBase64.length > 2_000_000) return null;
  const raw = qr.qrImageBase64.replace(/^data:image\/png;base64,/, '').replace(/\s/g, '');
  // Only local PNG data is rendered. No untrusted remote image or SVG URL is loaded.
  if (!raw.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  return `data:image/png;base64,${raw}`;
}

function releaseLink(state: UpdateState | null): string | null {
  if (!state?.releaseUrl) return null;
  try {
    const url = new URL(state.releaseUrl);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function QrPanel({ session }: { session: EditorSession }) {
  const [busy, setBusy] = useState<'qr.start' | 'qr.cancel' | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [response, setResponse] = useState<QrState | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const qr = session.qr ?? response;
  const image = localPng(qr);
  const run = async (action: 'qr.start' | 'qr.cancel') => {
    setBusy(action);
    setFeedback(null);
    try {
      const result = await session.request(action);
      if (!result || typeof result !== 'object' || !('status' in result) || typeof result.status !== 'string') throw new Error('服务器没有返回有效的扫码状态。');
      setResponse(result as QrState);
      setFeedback({ error: false, text: action === 'qr.start' ? '服务器已确认启动扫码流程，请等待实时二维码。' : '服务器已确认取消扫码流程。' });
    } catch (error) { setFeedback({ error: true, text: errorText(error) }); }
    finally { setBusy(null); }
  };
  return <section className="panel" aria-labelledby="qr-title"><div className="panel-heading"><div><span className="eyebrow">BOT AUTHENTICATION</span><h2 id="qr-title">机器人扫码登录</h2><p>启动服务器的扫码流程；二维码直接来自授权服务器。</p></div><Icon name="qr" size={28} /></div>
    <div className="qr-layout"><div className="qr-image-box">{image && failedImage !== image ? <img src={image} alt="服务器机器人登录二维码" width="248" height="248" onError={() => setFailedImage(image)} /> : <div className="empty-state"><Icon name="qr" size={52} /><p>{image ? '二维码图片无法解码' : '尚无可用二维码'}</p><span>启动扫码后等待服务器推送本地 PNG。</span></div>}</div><div className="qr-details"><span className="badge badge-neutral">{qr?.status ?? '等待服务器状态'}</span><h3>在机器人对应的客户端扫码</h3><p>{qr?.message || '扫码状态、成功或取消结果将通过实时通道更新。页面不会访问外部图片地址。'}</p><div className="button-row"><button type="button" className="button button-primary" disabled={!session.canSend || !!busy} onClick={() => void run('qr.start')}>{busy === 'qr.start' ? '正在启动…' : '启动扫码'}</button><button type="button" className="button button-secondary" disabled={!session.canSend || !!busy} onClick={() => void run('qr.cancel')}>{busy === 'qr.cancel' ? '正在取消…' : '取消扫码'}</button></div><small className="muted">二维码可能包含短期登录凭据，请勿分享或截图给他人。</small></div></div>
    {feedback && <div className={`alert ${feedback.error ? 'alert-error' : 'alert-success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
  </section>;
}

export function UpdatePanel({ session }: { session: EditorSession }) {
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<UpdateState | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const state = session.update ?? response;
  const url = releaseLink(state);
  const check = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await session.request('update.check');
      if (!result || typeof result !== 'object' || !('current' in result) || typeof result.current !== 'string') throw new Error('服务器没有返回有效的版本检查状态。');
      const checked = result as UpdateState;
      setResponse(checked);
      setFeedback({ error: !!checked.error, text: checked.error || (checked.checking ? '服务器已开始检查，等待实时结果。' : checked.checked ? '服务器已返回本次版本检查结果。' : '服务器返回的状态尚未完成检查，请查看实时状态。') });
    } catch (error) { setFeedback({ error: true, text: errorText(error) }); }
    finally { setBusy(false); }
  };
  return <section className="panel" aria-labelledby="update-title"><div className="panel-heading"><div><span className="eyebrow">RELEASE MONITOR</span><h2 id="update-title">版本与更新</h2><p>查看服务器插件的远程更新检查结果。此页面不会安装更新。</p></div><Icon name="update" size={28} /></div>
    <div className="update-card"><div className="update-symbol"><Icon name="update" size={30} /></div><div><h3>{!state ? '等待服务器版本状态' : state.checking ? '正在检查更新…' : state.error ? '检查更新失败' : !state.checked ? '尚未完成更新检查' : state.outdated ? '发现可用的新版本' : '当前没有发现新版本'}</h3><p>{state?.error || '更新信息由服务器提供，请以官方发布说明为准。'}</p></div>{state?.checked && !state.error && <span className={`badge ${state.outdated ? 'badge-amber' : 'badge-green'}`}>{state.outdated ? '可更新' : '已检查'}</span>}</div>
    <dl className="detail-grid"><div><dt>当前版本</dt><dd>{state?.current ?? session.status?.version ?? '—'}</dd></div><div><dt>最新版本</dt><dd>{state?.latest || '—'}</dd></div><div><dt>自动检查</dt><dd>{state ? state.enabled ? '已启用' : '已关闭' : '—'}</dd></div><div><dt>上次检查</dt><dd>{state?.checkedAt ? new Date(state.checkedAt).toLocaleString('zh-CN') : '尚未检查'}</dd></div></dl>
    <div className="button-row"><button type="button" className="button button-primary" disabled={!session.canSend || busy || state?.checking} onClick={() => void check()}><Icon name="update" size={17} />{busy || state?.checking ? '正在检查…' : '立即检查更新'}</button>{url && <a className="button button-secondary" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看发布页面<Icon name="arrow" size={17} /></a>}</div>
    {feedback && <div className={`alert ${feedback.error ? 'alert-error' : 'alert-success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
  </section>;
}
