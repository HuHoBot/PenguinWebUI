import { useEffect, useId, useState } from 'react';
import { UNCHANGED_SECRET, type Configuration } from '../shared/protocol';
import { errorText } from './api';
import type { EditorSession } from './useEditor';

const labels: Record<string, string> = {
  enable: '启用', enabled: '启用', pushMenu: '在菜单中展示', priority: '面板优先级', commands: '命令设置', customCommands: '自定义命令',
  customcommands: '自定义命令', 'full-amount': '全量模式', 'filter-regex': '过滤正则', serverName: '服务器名称', name: '名称', password: '密码', token: '令牌',
  debug: '调试模式', groups: 'QQ群列表', message: '消息', prefix: '前缀', timeout: '超时',
};
const sectionDescriptions: Record<string, string> = {
  webui: '独立网页管理入口；远程访问必须使用 HTTPS。',
  'update-check': '仅检查并提示新版本，不会下载或替换插件。',
  bot: 'QQ 机器人连接信息；凭据留空时，启动后可通过控制台二维码扫码绑定。',
  'chat-format': '控制游戏消息与 QQ 群消息的格式及转发条件。',
  'player-events': '控制玩家进退服消息的转发规则与消息格式。',
  'server-notify': '配置服务器正常关闭、重启和异常退出时的群通知。',
  markdown: '将功能配置键映射到插件数据目录 Markdown/ 下的文件。',
  motd: '配置服务器信息查询所用的地址、接口和文本。',
  whitelist: '配置添加和移除白名单时执行的服务器命令。',
  admin: '选择 QQ 群管理员和手动名单的授权规则。',
  features: '控制认证、全量功能和群成员事件订阅。',
  commands: 'enable 控制命令是否可执行；pushMenu 控制 QQ 指令面板显示，priority 为 0–999，数值越小越靠前。面板最多 20 项，按优先级排序。',
  'command-panel': '是否在 QQ 指令面板展示管理员命令；不会改变命令实际执行权限。',
  'custom-commands': '自定义命令格式：key、command、permission、pushMenu。支持 {params}、{group}、{user}、{name}（当前回退为 QQ 昵称；本项目无 MC 绑定）、{nickname}（QQ 昵称）、{0}、{1}… 和 &1、&2…；/执行仅允许 permission=0，/管理员执行可执行全部权限等级。',
  '基础设置': '未归入其他分组的顶层配置项。',
};
const fieldDescriptions: Record<string, string> = {
  'serverName': '服务器显示名称，可在进服/退服消息格式中使用 {server}。',
  'webui.enabled': '允许通过 /huhobot webui 建立独立网页管理通道。',
  'webui.url': '网页站点地址必须是纯 origin，不带路径、查询或片段；远程站点使用 HTTPS，本机开发可用 HTTP。',
  'update-check.enabled': '启动时异步检查更新，仅提示，不下载或安装。',
  'update-check.url': '可填逗号分隔的 HTTP(S) 数据源；留空时查询 HuHoBot/PenguinClient GitHub Releases。',
  'bot.app-id': 'QQ 机器人 App ID。留空时启动后会在控制台输出二维码，可用手机 QQ 扫码填写并连接。',
  'bot.secret': 'QQ 机器人 App Secret。留空时启动后会在控制台输出二维码，可用手机 QQ 扫码填写并连接。',
  'bot.groups': '要连接的 QQ 群号列表。',
  'bot.suppress-console-output': '屏蔽 QQBot 依赖直接写入 System.out 的调试信息。',
  'chat-format.from-game': '游戏消息转发到 QQ 群时使用的格式。',
  'chat-format.from-group': 'QQ 群消息转发到游戏时使用的格式。',
  'chat-format.post-chat': '是否将游戏聊天内容转发到 QQ 群。',
  'chat-format.start-with': '只转发以此内容开头的游戏消息，并在转发前移除前缀；留空则转发全部消息。',
  'player-events.always-forward': '关闭时遵循平台事件状态（例如隐藏的进退服消息）；开启后始终转发。',
  'player-events.join.format': '玩家加入消息格式；支持 {name}、{player}、{server}、{platform}。',
  'player-events.join.enabled': '是否转发玩家加入消息。',
  'player-events.quit.enabled': '是否转发玩家离开消息。',
  'server-notify.shutdown.enabled': '是否向 QQ 群发送正常关服通知。',
  'server-notify.shutdown.message': '正常关服时发送的群消息。',
  'server-notify.restart.enabled': '是否向 QQ 群发送服务器重启通知。',
  'server-notify.restart.message': '服务器重启完成后发送的群消息。',
  'server-notify.crash.enabled': '是否向 QQ 群发送意外关闭通知。',
  'server-notify.crash.message': '服务器崩溃或被强制结束时发送的群消息。',
  'markdown.queryOnline': '在线玩家查询功能使用的 Markdown 文件名，位于插件数据目录的 Markdown/ 下。',
  'markdown.motd': '服务器信息查询功能使用的 Markdown 文件名，位于插件数据目录的 Markdown/ 下。',
  'command-sender': 'Hybrid 同时收集命令发送者输出和服务端日志；其他值只收集命令发送者输出。',
  'motd.server-ip': '服务器信息查询使用的服务器地址。',
  'motd.server-port': '服务器信息查询使用的服务器端口。',
  'motd.api': '可选的服务器信息 API 地址。',
  'motd.text': '服务器信息查询展示的自定义文本。',
  'motd.post-img': '是否在服务器信息中发送图片。',
  'motd.use-markdown': '是否使用 Markdown 文件作为服务器信息内容。',
  'whitelist.add-command': '添加白名单时执行的命令；{name} 会替换为玩家名。',
  'whitelist.del-command': '移除白名单时执行的命令；{name} 会替换为玩家名。',
  'filter-regex': '用于过滤消息的正则表达式列表。',
  'admin.mode': '选择授权方式：仅 QQ 群主/管理员、仅手动名单，或满足任一方式即可。',
  'admin.openids': '手动授权的 QQ OpenID 列表。',
  'features.enable-auth': '是否启用 QQ 头像认证功能。',
  'features.full-amount': '是否开启全量模式；开启后，未命中命令的所有消息都会被转发到游戏内。',
  'features.group-member-events': '订阅群成员进退群与入群申请事件；需要机器人具备群管理权限，订阅失败可能导致连接被拒，修改后需重启。',
  'audit.base-url': 'OpenAI 兼容接口地址；仅本地敏感词命中后调用二审。',
  'audit.api-key': 'OpenAI 兼容接口密钥；接口不可用时自动采用本地屏蔽结果。',
  'custom-commands': '每项包含 key、command、permission、pushMenu；占位符支持 {params}、{group}、{user}、{0}、{1}…，并兼容 &1、&2…。',
};
const stringArrayPaths: Record<string, true> = { 'bot.groups': true, 'admin.openids': true, 'filter-regex': true, 'command-blacklist': true };
const isObject = (value: unknown): value is Configuration => value !== null && typeof value === 'object' && !Array.isArray(value);
const sensitiveKey = /password|passwd|secret|token|api.?key|authorization|credential|access.?key|private.?key/i;

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
    {fieldDescriptions[path.join('.')] && <small className="config-description">{fieldDescriptions[path.join('.')]}</small>}
    {secret && !revealed
      ? <input id={id} type="password" autoComplete="off" value={raw} onChange={(event) => edit(event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={`${id}-hint`} spellCheck={false} />
      : <textarea id={id} className="json-input" value={raw} onChange={(event) => edit(event.target.value)} disabled={disabled} rows={Math.min(12, Math.max(4, raw.split('\n').length))} aria-invalid={!!error} aria-describedby={`${id}-hint`} spellCheck={false} autoComplete="off" />}
    <small id={`${id}-hint`} className={error ? 'field-error' : 'field-hint'}>{error ?? (secret ? '此 JSON 包含敏感字段，默认隐藏。不会发送到第三方。' : '使用标准 JSON 编辑列表或复杂配置；保存前必须是有效 JSON。')}</small>
  </div>;
}

function StringArrayField({ name, path, value, disabled, change, reportError }: FieldProps) {
  const id = useId();
  const values = value as string[];
  const error = values.findIndex((item) => !item.trim()) >= 0 ? `第 ${values.findIndex((item) => !item.trim()) + 1} 项不能为空。` : null;
  const commit = (next: string[]) => {
    change(path, next);
    reportError(path, next.some((item) => !item.trim()) ? `列表项不能为空。` : null);
  };
  return <div className="config-field config-field-wide list-editor">
    <div className="field-label-row"><label>{labels[name] ?? name} <code>{name}</code></label><span className="list-count">{values.length} 项</span></div>
    {fieldDescriptions[path.join('.')] && <small className="config-description">{fieldDescriptions[path.join('.')]}</small>}
    <div className="string-list">{values.map((item, index) => <div className="string-list-row" key={`${id}-${index}`}>
      <label className="visually-hidden" htmlFor={`${id}-${index}`}>{labels[name] ?? name} 第 {index + 1} 项</label>
      <input id={`${id}-${index}`} type="text" value={item} disabled={disabled} aria-invalid={!!error} onChange={(event) => commit(values.map((entry, row) => row === index ? event.target.value : entry))} />
      <button type="button" className="button button-secondary list-remove" aria-label={`删除第 ${index + 1} 项`} disabled={disabled} onClick={() => commit(values.filter((_, row) => row !== index))}>删除</button>
    </div>)}</div>
    {error && <small className="field-error" role="alert">{error}</small>}
    <button type="button" className="button button-secondary list-add" disabled={disabled} onClick={() => commit([...values, ''])}>添加一项</button>
  </div>;
}

function validateCustomCommands(entries: unknown[]): string | null {
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry) || typeof entry.key !== 'string' || !entry.key.trim() || typeof entry.command !== 'string' || !entry.command.trim()) return `第 ${index + 1} 条命令需要填写 key 和 command。`;
    if (entry.permission !== undefined && entry.permission !== null && (typeof entry.permission !== 'number' || !Number.isInteger(entry.permission))) return `第 ${index + 1} 条命令的 permission 必须是整数。`;
    if (entry.pushMenu !== undefined && typeof entry.pushMenu !== 'boolean') return `第 ${index + 1} 条命令的 pushMenu 必须是布尔值。`;
  }
  return null;
}

function CustomCommandsField({ name, path, value, disabled, change, reportError }: FieldProps) {
  const id = useId();
  const commands = value as Configuration[];
  const commit = (next: Configuration[]) => {
    change(path, next);
    reportError(path, validateCustomCommands(next));
  };
  const update = (index: number, key: string, nextValue: unknown) => commit(commands.map((entry, row) => row === index ? { ...(isObject(entry) ? entry : {}), [key]: nextValue } : entry));
  return <div className="config-field config-field-wide command-list-editor">
    <div className="field-label-row"><label>{labels[name] ?? '自定义命令'} <code>{name}</code></label><span className="list-count">{commands.length} 条命令</span></div>
    {fieldDescriptions[path.join('.')] && <small className="config-description">{fieldDescriptions[path.join('.')]}</small>}
    {commands.map((entry, index) => {
      const command = isObject(entry) ? entry : {};
      const rowKey = typeof command.key === 'string' && command.key ? command.key : `${id}-${index}`;
      return <fieldset className="command-entry" key={rowKey}>
        <legend>命令 {index + 1}</legend>
        <div className="command-entry-grid">
          <label htmlFor={`${id}-${index}-key`}>指令名称 <code>key</code><input id={`${id}-${index}-key`} type="text" value={typeof command.key === 'string' ? command.key : ''} disabled={disabled} onChange={(event) => update(index, 'key', event.target.value)} /></label>
          <label htmlFor={`${id}-${index}-permission`}>权限等级 <code>permission</code><input id={`${id}-${index}-permission`} type="number" step="1" value={typeof command.permission === 'number' ? command.permission : ''} disabled={disabled} onChange={(event) => update(index, 'permission', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
          <label className="command-entry-wide" htmlFor={`${id}-${index}-command`}>执行命令 <code>command</code><textarea id={`${id}-${index}-command`} rows={2} value={typeof command.command === 'string' ? command.command : ''} disabled={disabled} onChange={(event) => update(index, 'command', event.target.value)} /></label>
          <label className="command-menu-toggle" htmlFor={`${id}-${index}-push-menu`}><span>推送到 QQ 指令面板 <code>pushMenu</code></span><span className="switch"><input id={`${id}-${index}-push-menu`} type="checkbox" checked={typeof command.pushMenu === 'boolean' ? command.pushMenu : true} disabled={disabled} onChange={(event) => update(index, 'pushMenu', event.target.checked)} /><span className="switch-track" /></span></label>
          <button type="button" className="button button-secondary command-remove" disabled={disabled} onClick={() => commit(commands.filter((_, row) => row !== index))}>删除命令</button>
        </div>
      </fieldset>;
    })}
    <button type="button" className="button button-secondary list-add" disabled={disabled} onClick={() => commit([...commands, { key: '', command: '', permission: 0, pushMenu: true }])}>添加自定义命令</button>
  </div>;
}

function ScalarField({ name, path, value, disabled, change, reportError }: FieldProps) {
  const id = useId();
  const description = fieldDescriptions[path.join('.')];
  const [numberText, setNumberText] = useState(String(value));
  const [numberError, setNumberError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [secret] = useState(() => value === UNCHANGED_SECRET || path.some((key) => sensitiveKey.test(key)));
  if (typeof value === 'boolean') return <div className="config-field toggle-field">
    <label htmlFor={id}><span>{labels[name] ?? name}<code>{name}</code>{description && <small className="config-description">{description}</small>}</span>
      <span className="switch"><input id={id} type="checkbox" checked={value} disabled={disabled} onChange={(event) => change(path, event.target.checked)} /><span className="switch-track" /></span>
    </label>
  </div>;
  if (typeof value === 'number') return <div className="config-field">
    <label htmlFor={id}>{labels[name] ?? name} <code>{name}</code></label>
    {description && <small className="config-description">{description}</small>}
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
    {description && <small className="config-description">{description}</small>}
    {value.includes('\n') && !secret
      ? <textarea id={id} rows={4} value={value} disabled={disabled} onChange={(event) => change(path, event.target.value)} />
      : <input id={id} type={secret && !revealed ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={value === UNCHANGED_SECRET ? '' : value} placeholder={value === UNCHANGED_SECRET ? '未修改：保留服务器原值' : undefined} disabled={disabled} onChange={(event) => change(path, event.target.value)} />}
    {secret && <small className="field-hint">{value === UNCHANGED_SECRET ? '服务器原值不会下发。留空不编辑将保留原值；主动输入（包括清空）才会替换。' : '新值通过端到端加密发送，仅在当前授权页面中暂存。'}</small>}
    {value === UNCHANGED_SECRET && <button type="button" className="text-button" disabled={disabled} onClick={() => change(path, '')}>主动清空服务器原值（保存后生效）</button>}
  </div>;
}

function ConfigValueField(props: FieldProps) {
  const { path, value } = props;
  const fieldPath = path.join('.');
  if (fieldPath === 'custom-commands' && Array.isArray(value)) return <CustomCommandsField {...props} />;
  if (Array.isArray(value) && (stringArrayPaths[fieldPath] || value.length > 0 && value.every((item) => typeof item === 'string'))) return <StringArrayField {...props} />;
  if (fieldPath === 'admin.mode') return <div className="config-field">
    <label htmlFor="config-admin-mode">授权方式 <code>mode</code></label>
    {fieldDescriptions[fieldPath] && <small className="config-description">{fieldDescriptions[fieldPath]}</small>}
    <select id="config-admin-mode" value={typeof value === 'string' ? value : 'both'} disabled={props.disabled} onChange={(event) => props.change(path, event.target.value)}>
      <option value="qq">仅群主和群管理员</option><option value="config">仅手动名单</option><option value="both">群管理或手动名单</option>
    </select>
  </div>;
  if (Array.isArray(value) || isObject(value)) return <JsonField {...props} />;
  return <ScalarField {...props} />;
}

function isExpandableObject(name: string, value: unknown, path: string[]): value is Configuration {
  return isObject(value) && Object.keys(value).length > 0 && !/custom.?commands/i.test(name) && path.length < 6;
}

function hasMatchingKey(value: unknown, name: string, path: string[], query: string): boolean {
  if (name === 'config-version') return false;
  if (!query) return true;
  const fullPath = path.at(-1) === name ? path : name ? [...path, name] : path;
  const descriptions = fullPath.map((key) => sectionDescriptions[key]).concat(fieldDescriptions[fullPath.join('.')] ?? '').join(' ');
  const searchable = `${name} ${labels[name] ?? ''} ${fullPath.join(' ')} ${descriptions}`.toLocaleLowerCase();
  if (searchable.includes(query)) return true;
  return isObject(value) && Object.entries(value).some(([childName, child]) => hasMatchingKey(child, childName, fullPath, query));
}

function countConfigFields(value: unknown, name = ''): number {
  if (isObject(value) && Object.keys(value).length > 0 && !/custom.?commands/i.test(name)) {
    return Object.entries(value).reduce((count, [childName, child]) => childName === 'config-version' ? count : count + countConfigFields(child, childName), 0);
  }
  return 1;
}

function countEnabledValues(value: unknown, name = ''): number {
  if (typeof value === 'boolean') return Number(value && /^(enable|enabled|pushmenu)$/i.test(name));
  if (isObject(value)) return Object.entries(value).reduce<number>((count, [childName, child]) => count + countEnabledValues(child, childName), 0);
  return 0;
}

function collectSectionPaths(values: Configuration, path: string[] = []): string[] {
  return Object.entries(values).flatMap(([name, value]) => {
    if (!isExpandableObject(name, value, path)) return [];
    const nestedPath = [...path, name];
    return [JSON.stringify(nestedPath), ...collectSectionPaths(value, nestedPath)];
  });
}

function ConfigSection({ name, path, values, stateKey, query, expandedPaths, setExpandedPaths, disabled, change, reportError }: {
  name: string;
  path: string[];
  values: Configuration;
  stateKey: string;
  query: string;
  expandedPaths: Set<string>;
  setExpandedPaths: (update: (current: Set<string>) => Set<string>) => void;
  disabled: boolean;
  change: FieldProps['change'];
  reportError: FieldProps['reportError'];
}) {
  const matches = !query || hasMatchingKey(values, name, path, query);
  const open = expandedPaths.has(stateKey) || !!query && matches;
  const fieldCount = Object.values(values).reduce<number>((count, value) => count + countConfigFields(value), 0);
  const enabledCount = countEnabledValues(values);
  return <details className={`config-section ${path.length <= 1 ? 'config-section-root' : ''}`} open={open} onToggle={(event) => {
    const nextOpen = event.currentTarget.open;
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (nextOpen) next.add(stateKey); else next.delete(stateKey);
      return next;
    });
  }}>
    <summary>
      <span className="config-section-heading"><span className="config-section-title">{labels[name] ?? name}{name !== '基础设置' && <code>{name}</code>}</span>{sectionDescriptions[name] && <small className="config-section-description">{sectionDescriptions[name]}</small>}</span>
      <span className="config-section-count">{fieldCount} 项配置{enabledCount ? ` · ${enabledCount} 项已启用` : ''}</span>
      <span className="config-section-chevron" aria-hidden="true" />
    </summary>
    <div className="config-section-content"><Fields values={values} path={path} query={query} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} disabled={disabled} change={change} reportError={reportError} /></div>
  </details>;
}

type ConfigSectionProps = Parameters<typeof ConfigSection>[0];

const categoryKeys: Record<string, string[]> = {
  '常用设置': ['webui', 'update-check', 'bot', 'serverName'],
  '消息与通知': ['chat-format', 'player-events', 'server-notify'],
  '命令管理': ['commands', 'custom-commands', 'customCommands', 'whitelist', 'command-sender'],
  '功能与查询': ['markdown', 'motd', 'features'],
  '权限与审计': ['admin', 'audit', 'filter-regex'],
};

function Fields({ values, path = [], query, category, setCategory, expandedPaths, setExpandedPaths, disabled, change, reportError }: {
  values: Configuration;
  path?: string[];
  query: string;
  category?: string;
  setCategory?: (value: string) => void;
  expandedPaths: Set<string>;
  setExpandedPaths: ConfigSectionProps['setExpandedPaths'];
  disabled: boolean;
  change: FieldProps['change'];
  reportError: FieldProps['reportError'];
}) {
  const entries = Object.entries(values).filter(([name, value]) => name !== 'config-version' && hasMatchingKey(value, name, path, query));
  if (!path.length) {
    const selectedCategory = category ?? '常用设置';
    const selectedKeys = categoryKeys[selectedCategory] ?? [];
    const knownKeys = Object.values(categoryKeys).flat();
    const unknown = entries.filter(([name]) => !knownKeys.includes(name));
    const visible = query ? entries : selectedCategory === '其他设置' ? unknown : entries.filter(([name]) => selectedKeys.includes(name));
    const availableCategories = Object.keys(categoryKeys).filter((name) => Object.entries(values).some(([key]) => categoryKeys[name].includes(key)));
    if (unknown.length) availableCategories.push('其他设置');
    return <>
      {!query && <div className="config-categories" role="group" aria-label="配置分类">{availableCategories.map((name) => {
        const keys = name === '其他设置' ? unknown.map(([key]) => key) : categoryKeys[name];
        const count = Object.keys(values).filter((key) => keys.includes(key)).length;
        return <button key={name} type="button" aria-pressed={selectedCategory === name} className={`config-category ${selectedCategory === name ? 'active' : ''}`} onClick={() => setCategory?.(name)}><span>{name}</span><small>{count}</small></button>;
      })}</div>}
      {query && <p className="config-search-results">搜索全部分类 · {visible.length} 个匹配分组或字段</p>}
      <div className="config-grid">{visible.map(([name, value]) => {
        if (isExpandableObject(name, value, path)) return <ConfigSection key={name} name={name} path={[name]} values={value} stateKey={JSON.stringify([name])} query={query} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} disabled={disabled} change={change} reportError={reportError} />;
        return <ConfigValueField key={name} name={name} path={[name]} value={value} disabled={disabled} change={change} reportError={reportError} />;
      })}</div>
    </>;
  }
  return <div className="config-grid">{entries.map(([name, value]) => {
    const nestedPath = [...path, name];
    if (isExpandableObject(name, value, path)) return <ConfigSection key={name} name={name} path={nestedPath} values={value} stateKey={JSON.stringify(nestedPath)} query={query} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} disabled={disabled} change={change} reportError={reportError} />;
    return <ConfigValueField key={name} name={name} path={nestedPath} value={value} disabled={disabled} change={change} reportError={reportError} />;
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
  const [search, setSearch] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [category, setCategory] = useState('常用设置');
  const [busy, setBusy] = useState<'load' | 'save' | 'reload' | 'reset' | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [baseRevision, setBaseRevision] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const groupNames = session.status?.groupNames ?? {};
  const groups = session.status?.groups ?? [];
  const groupLabel = (group: string) => groupNames[group] ? `${groupNames[group]} (${group})` : group;

  const accept = (values: Configuration, revision = session.configuration?.revision ?? 0) => {
    setDraft(JSON.parse(JSON.stringify(values)) as Configuration);
    setDirty(false);
    setExternalChange(false);
    setFieldErrors({});
    setBaseRevision(revision);
    setFormVersion((value) => value + 1);
    setSearch('');
    setExpandedPaths(new Set());
    setCategory('常用设置');
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
  const query = search.trim().toLocaleLowerCase();
  const hasSearchResults = !!draft && (!query || hasMatchingKey(draft, '', [], query));
  return <section className="panel configuration-panel" aria-labelledby="config-title">
    <div className="panel-heading"><div><span className="eyebrow">CONFIGURATION</span><h2 id="config-title">配置管理</h2><p>修改全局设置，或按群覆盖命令的启用与菜单显示。</p></div><span className={`badge ${dirty ? 'badge-amber' : 'badge-neutral'}`}>{dirty ? '有未保存的修改' : '已同步'}</span></div>
    <div className="config-toolbar"><div className="scope-control"><label htmlFor="config-scope">配置范围</label><select id="config-scope" value={scope} disabled={disabled} onChange={(event) => switchScope(event.target.value)}><option value="">全局配置</option>{!groups.includes(scope) && scope && <option value={scope}>群 {groupLabel(scope)}（当前未连接）</option>}{groups.map((group) => <option key={group} value={group}>群 {groupLabel(group)}</option>)}</select></div><button type="button" className="button button-secondary" disabled={disabled} onClick={() => void reloadFromDisk()}>{busy === 'reload' ? '正在重载…' : '从磁盘重载配置'}</button></div>
    {scope && <div className="inline-info">正在编辑群 <strong>{groupLabel(scope)}</strong> 的命令设置。显示的是包含全局继承的有效配置；保存会设置该群覆盖，清除后恢复继承。</div>}
    {externalChange && <div className="alert alert-warning" role="status"><div><strong>服务器配置发生了外部变更</strong><p>你的未保存编辑已保留。重新读取会用服务器当前值替换当前范围的草稿。</p></div><button type="button" className="button button-secondary" disabled={disabled} onClick={() => { if (!dirty || window.confirm('丢弃未保存修改并读取服务器最新配置？')) void load(scope); }}>读取最新配置</button></div>}
    {feedback && <div className={`alert ${feedback.error ? 'alert-error' : 'alert-success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
    {draft && <div className="config-discovery">
      <label className="config-search"><span>查找配置项</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、键名或注释" aria-label="搜索配置字段和说明" /></label>
      <div className="button-row"><button type="button" className="button button-secondary" onClick={() => setExpandedPaths(new Set(collectSectionPaths(draft)))}>展开全部</button><button type="button" className="button button-secondary" onClick={() => setExpandedPaths(new Set())}>收起全部</button></div>
    </div>}
    {draft && hasSearchResults ? <Fields key={`${scope}:${formVersion}`} values={draft} query={query} category={category} setCategory={setCategory} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} disabled={disabled} change={(path, value) => {
      setDraft((current) => current ? applyValue(current, path, value) : current);
      setDirty(true);
      setFeedback(null);
    }} reportError={(path, error) => {
      setFieldErrors((current) => { const next = { ...current }; const key = JSON.stringify(path); if (error) next[key] = error; else delete next[key]; return next; });
      if (error) setDirty(true);
    }} /> : draft ? <div className="empty-state small"><p>没有找到匹配的配置项或说明</p><span>搜索匹配配置名称、英文键名、路径和注释，不会检索配置值。</span></div> : <div className="empty-state"><p>{busy === 'load' ? '正在读取服务器配置…' : '等待服务器配置快照，或手动读取当前配置。'}</p><button type="button" className="button button-secondary" disabled={disabled} onClick={() => void load(scope)}>读取配置</button></div>}
    <div className="config-footer"><span className="muted">{hasErrors ? '请修正字段格式后再保存。' : '保存仅在收到服务器确认后才会显示成功。'}</span><div className="button-row">{scope && <button type="button" className="button button-secondary" disabled={disabled} onClick={() => setConfirmReset(true)}>清除此群覆盖</button>}<button type="button" className="button button-primary" disabled={disabled || !draft || !dirty || hasErrors} onClick={() => void save(false)}>{busy === 'save' ? '正在保存…' : '保存配置'}</button></div></div>
    {confirmReset && <div className="confirmation" role="alert"><strong>恢复群 {scope} 的全局继承？</strong><p>该群所有命令覆盖会清除；页面未保存的修改也会丢弃。不会修改全局设置。</p><div className="button-row"><button type="button" className="button button-secondary" onClick={() => setConfirmReset(false)}>取消</button><button type="button" className="button button-danger" disabled={disabled} onClick={() => void save(true)}>确认清除覆盖</button></div></div>}
  </section>;
}
