import { useEffect, useId, useState } from 'react';
import { UNCHANGED_SECRET, type Configuration } from '../shared/protocol';
import { errorText } from './api';
import type { EditorSession } from './useEditor';

const labels: Record<string, string> = {
  enable: '启用', enabled: '启用', pushMenu: '在菜单中展示', commands: '命令设置', customCommands: '自定义命令',
  customcommands: '自定义命令', serverName: '服务器名称', name: '名称', password: '密码', token: '令牌',
  debug: '调试模式', groups: '群组设置', message: '消息', prefix: '前缀', timeout: '超时',
};
const sensitiveKey = /password|passwd|secret|token|api.?key|authorization|credential|access.?key|private.?key/i;
const isObject = (value: unknown): value is Configuration => value !== null && typeof value === 'object' && !Array.isArray(value);

function containsSensitive(value: unknown): boolean {
  if (value === UNCHANGED_SECRET) return true;
  if (Array.isArray(value)) return value.some(containsSensitive);
  if (isObject(value)) return Object.entries(value).some(([key, nested]) => sensitiveKey.test(key) || containsSensitive(nested));
  return false;
}

interface FieldProps {
  name: string;
  path: string[];
  value: unknown;
  disabled: boolean;
  change: (path: string[], value: unknown) => void;
  reportError: (path: string[], error: string | null) => void;
}

function JsonField({ name, path, value, disabled, change, reportError }: FieldProps) {
  const secret = path.some((key) => sensitiveKey.test(key)) || containsSensitive(value);
  const stringify = (entry: unknown) => JSON.stringify(entry, null, secret ? undefined : 2) ?? 'null';
  const [raw, setRaw] = useState(() => stringify(value));
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  const edit = (text: string) => {
    setRaw(text);
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(value) && !Array.isArray(parsed)) throw new Error('此字段需要 JSON 数组。');
      if (isObject(value) && !isObject(parsed)) throw new Error('此字段需要 JSON 对象。');
      setError(null);
      reportError(path, null);
      change(path, parsed);
    } catch (failure) {
      const message = failure instanceof SyntaxError ? 'JSON 格式无效，请检查引号、逗号和括号。' : errorText(failure);
      setError(message);
      reportError(path, message);
    }
  };
  return <div className="config-field config-field-wide">
    <div className="field-label-row"><label htmlFor={id}>{labels[name] ?? name} <code>{name}</code></label>
      {secret && <button type="button" className="text-button" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? '隐藏内容' : '显示敏感内容'}</button>}
    </div>
    {secret && !revealed
      ? <input id={id} type="password" autoComplete="off" value={raw} onChange={(event) => edit(event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={`${id}-hint`} spellCheck={false} />
      : <textarea id={id} className="json-input" value={raw} onChange={(event) => edit(event.target.value)} disabled={disabled} rows={Math.min(12, Math.max(4, raw.split('\n').length))} aria-invalid={!!error} aria-describedby={`${id}-hint`} spellCheck={false} autoComplete="off" />}
    <small id={`${id}-hint`} className={error ? 'field-error' : 'field-hint'}>{error ?? (secret ? '此 JSON 包含敏感字段，默认隐藏。不会发送到第三方。' : '使用标准 JSON 编辑列表或复杂配置；保存前必须是有效 JSON。')}</small>
  </div>;
}

function ScalarField({ name, path, value, disabled, change, reportError }: FieldProps) {
  const id = useId();
  const [numberText, setNumberText] = useState(String(value));
  const [numberError, setNumberError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [secret] = useState(() => value === UNCHANGED_SECRET || path.some((key) => sensitiveKey.test(key)));
  if (typeof value === 'boolean') return <div className="config-field toggle-field">
    <label htmlFor={id}><span>{labels[name] ?? name}<code>{name}</code></span>
      <span className="switch"><input id={id} type="checkbox" checked={value} disabled={disabled} onChange={(event) => change(path, event.target.checked)} /><span className="switch-track" /></span>
    </label>
  </div>;
  if (typeof value === 'number') return <div className="config-field">
    <label htmlFor={id}>{labels[name] ?? name} <code>{name}</code></label>
    <input id={id} type="number" step="any" value={numberText} disabled={disabled} aria-invalid={numberError} onChange={(event) => {
      const raw = event.target.value;
      setNumberText(raw);
      const valid = raw.trim() !== '' && Number.isFinite(Number(raw));
      setNumberError(!valid);
      reportError(path, valid ? null : '请输入有效数值。');
      if (valid) change(path, Number(raw));
    }} />
    {numberError && <small className="field-error">请输入有效数值。</small>}
  </div>;
  if (typeof value !== 'string') return <JsonField name={name} path={path} value={value} disabled={disabled} change={change} reportError={reportError} />;
  return <div className={`config-field ${value.includes('\n') && !secret ? 'config-field-wide' : ''}`}>
    <div className="field-label-row"><label htmlFor={id}>{labels[name] ?? name} <code>{name}</code></label>
      {secret && <button type="button" className="text-button" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? '隐藏' : '显示'}</button>}
    </div>
    {value.includes('\n') && !secret
      ? <textarea id={id} rows={4} value={value} disabled={disabled} onChange={(event) => change(path, event.target.value)} />
      : <input id={id} type={secret && !revealed ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={value === UNCHANGED_SECRET ? '' : value} placeholder={value === UNCHANGED_SECRET ? '未修改：保留服务器原值' : undefined} disabled={disabled} onChange={(event) => change(path, event.target.value)} />}
    {secret && <small className="field-hint">{value === UNCHANGED_SECRET ? '服务器原值不会下发。留空不编辑将保留原值；主动输入（包括清空）才会替换。' : '新值通过端到端加密发送，仅在当前授权页面中暂存。'}</small>}
    {value === UNCHANGED_SECRET && <button type="button" className="text-button" disabled={disabled} onClick={() => change(path, '')}>主动清空服务器原值（保存后生效）</button>}
  </div>;
}

function Fields({ values, path = [], disabled, change, reportError }: { values: Configuration; path?: string[]; disabled: boolean; change: FieldProps['change']; reportError: FieldProps['reportError'] }) {
  return <div className="config-grid">{Object.entries(values).map(([name, value]) => {
    const nestedPath = [...path, name];
    if (isObject(value) && Object.keys(value).length > 0 && !/custom.?commands/i.test(name) && path.length < 6) return <fieldset key={name} className="config-section">
      <legend>{labels[name] ?? name} <code>{name}</code></legend>
      <Fields values={value} path={nestedPath} disabled={disabled} change={change} reportError={reportError} />
    </fieldset>;
    const Component = Array.isArray(value) || isObject(value) ? JsonField : ScalarField;
    return <Component key={name} name={name} path={nestedPath} value={value} disabled={disabled} change={change} reportError={reportError} />;
  })}</div>;
}

function applyValue(values: Configuration, path: string[], value: unknown): Configuration {
  const [key, ...remaining] = path;
  return { ...values, [key]: remaining.length ? applyValue(isObject(values[key]) ? values[key] : {}, remaining, value) : value };
}

function configurationResult(result: unknown): { values: Configuration; groupId: string | null } {
  if (!isObject(result) || !isObject(result.values) || !(typeof result.groupId === 'string' || result.groupId === null)) throw new Error('服务器返回的配置格式无效。');
  return { values: result.values, groupId: result.groupId };
}

export function ConfigEditor({ session }: { session: EditorSession }) {
  const [scope, setScope] = useState('');
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'load' | 'save' | 'reload' | 'reset' | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [baseRevision, setBaseRevision] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const groups = session.status?.groups ?? [];

  const accept = (values: Configuration, revision = session.configuration?.revision ?? 0) => {
    setDraft(JSON.parse(JSON.stringify(values)) as Configuration);
    setDirty(false);
    setExternalChange(false);
    setFieldErrors({});
    setBaseRevision(revision);
    setFormVersion((value) => value + 1);
  };

  useEffect(() => {
    if (!session.configuration) return;
    if (scope) {
      if (session.configuration.revision !== baseRevision) setExternalChange(true);
      return;
    }
    if (!draft || (!dirty && !busy && session.configuration.revision !== baseRevision)) {
      accept(session.configuration.values, session.configuration.revision);
    } else if (session.configuration.revision !== baseRevision) {
      setExternalChange(true);
    }
  }, [session.configuration, busy]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const load = async (groupId: string, changeScope = false) => {
    setBusy('load');
    setFeedback(null);
    try {
      const result = configurationResult(await session.request('config.get', { groupId: groupId || null }));
      if (result.groupId !== (groupId || null)) throw new Error('服务器返回了错误的配置范围。');
      if (changeScope) setScope(groupId);
      accept(result.values);
    } catch (error) { setFeedback({ error: true, text: errorText(error) }); }
    finally { setBusy(null); }
  };

  const switchScope = (groupId: string) => {
    if (dirty && !window.confirm('当前配置有未保存的修改。切换范围会丢弃这些修改，确定继续吗？')) return;
    setConfirmReset(false);
    void load(groupId, true);
  };

  const save = async (reset: boolean) => {
    if (!draft && !reset) return;
    setBusy(reset ? 'reset' : 'save');
    setFeedback(null);
    setConfirmReset(false);
    try {
      const response = await session.request('config.save', { values: reset ? {} : draft!, groupId: scope || null });
      if (!isObject(response) || response.saved !== true) throw new Error('服务器未确认配置保存，请先核对当前配置。');
      const result = configurationResult(response);
      if (result.groupId !== (scope || null)) throw new Error('服务器返回了错误的配置范围。');
      accept(result.values);
      setFeedback({ error: false, text: reset ? '此群的覆盖设置已清除，现在继承全局配置。' : '服务器已确认保存当前范围的配置。' });
    } catch (error) { setFeedback({ error: true, text: errorText(error) }); }
    finally { setBusy(null); }
  };

  const reloadFromDisk = async () => {
    if (!window.confirm('这会让服务器重新读取磁盘中的配置，丢弃页面未保存的编辑。确定重载吗？')) return;
    setBusy('reload');
    setFeedback(null);
    try {
      const result = await session.request('config.reload');
      if (!isObject(result) || result.reloaded !== true) throw new Error('服务器未确认配置重载。');
      const config = configurationResult(await session.request('config.get', { groupId: scope || null }));
      if (config.groupId !== (scope || null)) throw new Error('服务器返回了错误的配置范围。');
      accept(config.values);
      setFeedback({ error: false, text: '服务器已重载磁盘配置，页面已刷新。' });
    } catch (error) { setFeedback({ error: true, text: errorText(error) }); }
    finally { setBusy(null); }
  };

  const disabled = !!busy || !session.canSend;
  const hasErrors = Object.keys(fieldErrors).length > 0;
  return <section className="panel configuration-panel" aria-labelledby="config-title">
    <div className="panel-heading"><div><span className="eyebrow">CONFIGURATION</span><h2 id="config-title">配置管理</h2><p>修改全局设置，或按群覆盖命令的启用与菜单显示。</p></div><span className={`badge ${dirty ? 'badge-amber' : 'badge-neutral'}`}>{dirty ? '有未保存的修改' : '已同步'}</span></div>
    <div className="config-toolbar"><div className="scope-control"><label htmlFor="config-scope">配置范围</label><select id="config-scope" value={scope} disabled={disabled} onChange={(event) => switchScope(event.target.value)}><option value="">全局配置</option>{!groups.includes(scope) && scope && <option value={scope}>群 {scope}（当前未连接）</option>}{groups.map((group) => <option key={group} value={group}>群 {group}</option>)}</select></div><button type="button" className="button button-secondary" disabled={disabled} onClick={() => void reloadFromDisk()}>{busy === 'reload' ? '正在重载…' : '从磁盘重载配置'}</button></div>
    {scope && <div className="inline-info">正在编辑群 <strong>{scope}</strong> 的命令开关。显示的是包含全局继承的有效配置；保存会设置该群覆盖，清除后恢复继承。</div>}
    {externalChange && <div className="alert alert-warning" role="status"><div><strong>服务器配置发生了外部变更</strong><p>你的未保存编辑已保留。重新读取会用服务器当前值替换当前范围的草稿。</p></div><button type="button" className="button button-secondary" disabled={disabled} onClick={() => { if (!dirty || window.confirm('丢弃未保存修改并读取服务器最新配置？')) void load(scope); }}>读取最新配置</button></div>}
    {feedback && <div className={`alert ${feedback.error ? 'alert-error' : 'alert-success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
    {draft ? <Fields key={`${scope}:${formVersion}`} values={draft} disabled={disabled} change={(path, value) => {
      setDraft((current) => current ? applyValue(current, path, value) : current);
      setDirty(true);
      setFeedback(null);
    }} reportError={(path, error) => {
      setFieldErrors((current) => { const next = { ...current }; const key = JSON.stringify(path); if (error) next[key] = error; else delete next[key]; return next; });
      if (error) setDirty(true);
    }} /> : <div className="empty-state"><p>{busy === 'load' ? '正在读取服务器配置…' : '等待服务器配置快照，或手动读取当前配置。'}</p><button type="button" className="button button-secondary" disabled={disabled} onClick={() => void load(scope)}>读取配置</button></div>}
    <div className="config-footer"><span className="muted">{hasErrors ? '请修正字段格式后再保存。' : '保存仅在收到服务器确认后才会显示成功。'}</span><div className="button-row">{scope && <button type="button" className="button button-secondary" disabled={disabled} onClick={() => setConfirmReset(true)}>清除此群覆盖</button>}<button type="button" className="button button-primary" disabled={disabled || !draft || !dirty || hasErrors} onClick={() => void save(false)}>{busy === 'save' ? '正在保存…' : '保存配置'}</button></div></div>
    {confirmReset && <div className="confirmation" role="alert"><strong>恢复群 {scope} 的全局继承？</strong><p>该群所有命令覆盖会清除；页面未保存的修改也会丢弃。不会修改全局设置。</p><div className="button-row"><button type="button" className="button button-secondary" onClick={() => setConfirmReset(false)}>取消</button><button type="button" className="button button-danger" disabled={disabled} onClick={() => void save(true)}>确认清除覆盖</button></div></div>}
  </section>;
}
