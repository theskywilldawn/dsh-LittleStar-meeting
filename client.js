/**
 * dsh-xiaoxingchen-meeting — browser half.
 *
 * 在「设置」里加一页「星辰会议室」，把插件的可调参数摆出来：
 *   - 控制台标准输出 / 开房时弹出会议窗口 / 默认轮次上限（这三项可改，改完即生效）
 *   - 数据目录、归档名单、房间与纪要数量、封存名单（只读，用来看清它现在什么状态）
 *
 * 面板不自己编数据，一律打 host 侧的 /api/config —— 和插件实际读的是同一份配置，
 * 所以面板上看到的开关，就是会议跑起来时真正生效的开关。
 *
 * 契约来自 @deepseek-ai/dsh-client-ui-settings 的 settings.section（list slot）：
 *   注册描述符 { id, order, label }，渲染函数返回 React 元素。
 */
window.__ModuleLoader__.load({
	id: 'dsh-xiaoxingchen-meeting',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		const API = '/xiaoxingchen-meeting/api';
		const STYLE_ID = 'dsh-xiaoxingchen-meeting-style';
		const CSS = [
			'.mtg-wrap{display:flex;flex-direction:column;gap:14px;padding:2px 0 24px;color:var(--dsw-alias-label-primary)}',
			'.mtg-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
			'.mtg-title{font-size:14px;font-weight:600;margin:0}',
			'.mtg-btn{font-size:12px;padding:4px 12px;border-radius:8px;cursor:pointer;',
			'border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);',
			'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);',
			'color:var(--dsw-alias-brand-primary)}',
			'.mtg-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}',
			'.mtg-btn:disabled{opacity:.5;cursor:default}',
			'.mtg-stats{display:flex;flex-wrap:wrap;gap:8px}',
			'.mtg-chip{font-size:12px;padding:3px 9px;border-radius:999px;',
			'background:var(--dsw-alias-bg-layer-2,#0000000d);opacity:.85;font-variant-numeric:tabular-nums}',
			'.mtg-ok{color:#2e9e5b}',
			'.mtg-bad{color:#d9534f}',
			'.mtg-note{font-size:12px;opacity:.7;line-height:1.6}',
			'.mtg-rows{display:flex;flex-direction:column;gap:2px}',
			'.mtg-row{display:flex;align-items:flex-start;gap:12px;padding:9px 11px;border-radius:10px}',
			'.mtg-row:hover{background:color-mix(in srgb,currentColor 4%,transparent)}',
			'.mtg-row-main{flex:1;min-width:0}',
			'.mtg-row-name{font-size:13px;margin:0 0 3px}',
			'.mtg-row-desc{font-size:12px;opacity:.65;line-height:1.55;margin:0}',
			'.mtg-ctl{flex:none;display:flex;align-items:center;gap:6px;padding-top:1px}',
			'.mtg-switch{width:38px;height:22px;border-radius:999px;border:none;cursor:pointer;position:relative;',
			'transition:background .15s ease;background:color-mix(in srgb,currentColor 22%,transparent)}',
			'.mtg-switch[data-on="1"]{background:var(--dsw-alias-brand-primary)}',
			'.mtg-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;',
			'background:#fff;transition:transform .15s ease}',
			'.mtg-switch[data-on="1"]::after{transform:translateX(16px)}',
			'.mtg-switch:disabled{opacity:.5;cursor:default}',
			'.mtg-num{width:62px;font-size:12.5px;padding:4px 8px;border-radius:8px;text-align:center;',
			'border:1px solid color-mix(in srgb,currentColor 18%,transparent);',
			'background:var(--dsw-alias-bg-layer-2,#0000000d);color:inherit;font-variant-numeric:tabular-nums}',
			'.mtg-path{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.75;',
			'word-break:break-all;line-height:1.5;margin:2px 0 0}',
			'.mtg-sec{font-size:12px;opacity:.55;margin:6px 0 0;letter-spacing:.02em}',
		].join('');

		function useConfig() {
			const [state, setState] = React.useState({ loading: true, error: null, data: null });

			const load = React.useCallback(() => {
				setState((prev) => ({ ...prev, loading: true, error: null }));
				fetch(API + '/config', { cache: 'no-store' })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
					.then((data) => setState({ loading: false, error: null, data }))
					.catch((error) => setState({ loading: false, error: String((error && error.message) || error), data: null }));
			}, []);

			React.useEffect(() => { load(); }, [load]);
			return { ...state, reload: load };
		}

		/** 一行开关。 */
		function ToggleRow({ name, desc, on, busy, onChange }) {
			return h('div', { className: 'mtg-row' }, [
				h('div', { key: 'm', className: 'mtg-row-main' }, [
					h('p', { key: 'n', className: 'mtg-row-name' }, name),
					desc ? h('p', { key: 'd', className: 'mtg-row-desc' }, desc) : null,
				]),
				h('div', { key: 'c', className: 'mtg-ctl' },
					h('button', {
						type: 'button',
						className: 'mtg-switch',
						'data-on': on ? '1' : '0',
						disabled: busy,
						'aria-pressed': on ? 'true' : 'false',
						onClick: () => onChange(!on),
					})),
			]);
		}

		/** 设置页里的「星辰会议室」。 */
		function MeetingPanel({ ctx }) {
			const { loading, error, data, reload } = useConfig();
			const [busy, setBusy] = React.useState(null);
			const [local, setLocal] = React.useState({});

			const save = (patch) => {
				const key = Object.keys(patch)[0];
				setBusy(key);
				setLocal((prev) => ({ ...prev, ...patch }));
				fetch(API + '/config', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(patch),
				})
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
					.then(() => { setLocal({}); reload(); })
					.catch(() => { setLocal({}); reload(); })
					.finally(() => setBusy(null));
			};

			const head = h('div', { className: 'mtg-head' }, [
				h('h3', { key: 't', className: 'mtg-title' }, '\u661f\u8fb0\u4f1a\u8bae\u5ba4'),
				h('button', { key: 'r', type: 'button', className: 'mtg-btn', disabled: loading, onClick: reload },
					loading ? '\u8bfb\u53d6\u4e2d\u2026' : '\u5237\u65b0'),
				h('a', { key: 'w', className: 'mtg-btn', href: '/xiaoxingchen-meeting/', target: '_blank', rel: 'noreferrer',
					style: { textDecoration: 'none' } }, '\u4f1a\u573a\u5b9e\u51b5'),
			]);

			if (error !== null && error !== undefined) {
				return h('div', { className: 'mtg-wrap' }, [head,
					h('div', { key: 'e', className: 'mtg-note mtg-bad' },
						'\u8bfb\u4e0d\u5230\u63a5\u53e3\uff08' + error + '\uff09\u3002host \u534a\u8eab\u53ef\u80fd\u8fd8\u6ca1\u52a0\u8f7d\u2014\u2014\u91cd\u542f DSH \u540e\u518d\u8bd5\u3002')]);
			}
			if (data === null || data === undefined) {
				return h('div', { className: 'mtg-wrap' }, [head,
					h('div', { key: 'l', className: 'mtg-note' }, '\u8bfb\u53d6\u4e2d\u2026')]);
			}

			const cfg = data.config || {};
			const eff = { ...cfg, ...local };
			const stats = data.stats || {};

			const chips = [
				h('span', { key: 'v', className: 'mtg-chip' }, '\u7248\u672c ' + (data.version || '?')),
				h('span', { key: 'r', className: 'mtg-chip' }, (stats.rooms ?? 0) + ' \u95f4\u623f\u95f4'),
				h('span', { key: 'm', className: 'mtg-chip' }, (stats.minutes ?? 0) + ' \u4efd\u7eaa\u8981'),
				h('span', {
					key: 'a',
					className: 'mtg-chip' + ((stats.archived ?? 0) > 0 ? '' : ' mtg-ok'),
				}, '\u5df2\u5c01\u5b58 ' + (stats.archived ?? 0) + ' \u4f4d'),
			];

			/** 「浏览…」按钮：拿得到 directoryPicker 才提供（拿不到就只留手填输入框）。 */
			const pickButton = (ctx && typeof ctx.get === 'function' && ctx.get('remote'))
				? h('button', {
					key: 'pick', type: 'button', className: 'mtg-btn', disabled: busy === 'minutesDir',
					onClick: () => {
						try {
							const picker = ctx.get('remote')?.directoryPicker;
							if (!picker || typeof picker.pick !== 'function') return;
							Promise.resolve(picker.pick(new AbortController().signal))
								.then((dir) => { if (typeof dir === 'string' && dir.trim()) save({ minutesDir: dir.trim() }); })
								.catch(() => {});
						} catch { /* 选择器不可用就不做事 */ }
					},
				}, '\u6d4f\u89c8\u2026') : null;
			const rows = [
				ToggleRow({
					name: '\u63a7\u5236\u53f0\u6807\u51c6\u8f93\u51fa',
					desc: '\u628a\u4f1a\u573a\u5bf9\u8bdd\u540c\u65f6\u6253\u5230\u6807\u51c6\u8f93\u51fa\uff08DSH \u4ece\u7ec8\u7aef\u8d77\u65f6\u76f4\u63a5\u53ef\u89c1\uff09\u3002',
					on: eff.consoleLog !== false,
					busy: busy === 'consoleLog',
					onChange: (v) => save({ consoleLog: v }),
				}),
				ToggleRow({
					name: '\u5f00\u623f\u65f6\u5f39\u51fa\u4f1a\u8bae\u7a97\u53e3',
					desc: '\u6bcf\u5f00\u4e00\u573a\u4f1a\u5c31\u5f39\u4e00\u4e2a\u8ddf\u968f\u5b83\u7684\u53ef\u89c1\u63a7\u5236\u53f0\u7a97\u53e3\uff0c' +
						'\u4f1a\u573a\u5bf9\u8bdd\u5728\u91cc\u9762\u5b9e\u65f6\u6eda\u3002\u5173\u6389\u4e5f\u4e0d\u4e22\uff1a\u540c\u4e00\u4efd\u5185\u5bb9\u4ecd\u5199\u5728 live \u65e5\u5fd7\u91cc\u3002',
					on: eff.consoleWindow !== false,
					busy: busy === 'consoleWindow',
					onChange: (v) => save({ consoleWindow: v }),
				}),
				h('div', { key: 'rounds', className: 'mtg-row' }, [
					h('div', { key: 'm', className: 'mtg-row-main' }, [
						h('p', { key: 'n', className: 'mtg-row-name' }, '\u9ed8\u8ba4\u8f6e\u6b21\u4e0a\u9650'),
						h('p', { key: 'd', className: 'mtg-row-desc' },
							'meeting_open \u4e0d\u6307\u5b9a rounds \u65f6\u7528\u51e0\u8f6e\uff081\u201320\uff09\u3002\u5355\u573a\u4f1a\u4ecd\u53ef\u4ee5\u53e6\u5916\u6307\u5b9a\u3002'),
					]),
					h('div', { key: 'c', className: 'mtg-ctl' },
						h('input', {
							type: 'number', className: 'mtg-num', min: 1, max: 20,
							value: String(eff.defaultRounds ?? 2),
							disabled: busy === 'defaultRounds',
							onChange: (e) => setLocal((prev) => ({ ...prev, defaultRounds: e.target.value })),
							onBlur: (e) => {
								const n = Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 2)));
								if (n !== cfg.defaultRounds) save({ defaultRounds: n });
								else setLocal((prev) => ({ ...prev, defaultRounds: undefined }));
							},
						})),
				]),
				h('div', { key: 'speech', className: 'mtg-row' }, [
					h('div', { key: 'm', className: 'mtg-row-main' }, [
						h('p', { key: 'n', className: 'mtg-row-name' }, '\u53d1\u8a00\u957f\u5ea6\uff08\u8f6f\u4e0a\u9650\uff09'),
						h('p', { key: 'd', className: 'mtg-row-desc' },
							'\u5199\u7ed9\u53c2\u4f1a AI \u7684\u5efa\u8bae\u5b57\u6570\uff08100\u20135000\uff09\u3002\u8fd9\u662f\u8f6f\u8981\u6c42\uff1a\u5199\u8fdb\u4f1a\u8bae\u8981\u6c42\u91cc\u8ba9\u5b83\u4eec\u81ea\u5df1\u62ff\u634f\uff0c\u6ca1\u8bf4\u5b8c\u53ef\u4ee5\u7565\u8d85 \u2014\u2014 \u63d2\u4ef6\u4e0d\u4f1a\u786c\u5207\u4efb\u4f55\u4e00\u6761\u53d1\u8a00\u3002'),
					]),
					h('div', { key: 'c', className: 'mtg-ctl' },
						h('input', {
							type: 'number', className: 'mtg-num', min: 100, max: 5000, step: 100,
							value: String(eff.speechLimitChars ?? 800),
							disabled: busy === 'speechLimitChars',
							onChange: (e) => setLocal((prev) => ({ ...prev, speechLimitChars: e.target.value })),
							onBlur: (e) => {
								const n = Math.max(100, Math.min(5000, Math.round(Number(e.target.value) || 800)));
								if (n !== cfg.speechLimitChars) save({ speechLimitChars: n });
								else setLocal((prev) => ({ ...prev, speechLimitChars: undefined }));
							},
						})),
				]),
				h('div', { key: 'ctxwin', className: 'mtg-row' }, [
					h('div', { key: 'm', className: 'mtg-row-main' }, [
						h('p', { key: 'n', className: 'mtg-row-name' }, '\u4f1a\u8bae\u8bb0\u5f55\u7a97\u53e3\uff08\u6761\uff09'),
						h('p', { key: 'd', className: 'mtg-row-desc' },
							'\u6bcf\u6b21\u8bf7\u4e00\u4f4d\u53d1\u8a00\u65f6\uff0c\u968f\u6d88\u606f\u53ea\u5e26\u6700\u8fd1\u51e0\u6761\u53d1\u8a00\uff080\u201320\uff09\u3002\u66f4\u65e9\u7684\u6298\u53e0\u6210\u4e00\u884c\u8bf4\u660e\uff0c\u5b8c\u6574\u8bb0\u5f55\u5728\u4f1a\u573a\u5b9e\u51b5\u91cc \u2014\u2014 \u8fd9\u6837\u8f6e\u6b21\u8d8a\u9760\u540e\uff0c\u6295\u9012\u8fc7\u53bb\u7684\u5185\u5bb9\u4e0d\u4f1a\u8d8a\u957f\u3002'),
					]),
					h('div', { key: 'c', className: 'mtg-ctl' },
						h('input', {
							type: 'number', className: 'mtg-num', min: 0, max: 20,
							value: String(eff.contextRecentCount ?? 3),
							disabled: busy === 'contextRecentCount',
							onChange: (e) => setLocal((prev) => ({ ...prev, contextRecentCount: e.target.value })),
							onBlur: (e) => {
								const n = Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0)));
								if (n !== cfg.contextRecentCount) save({ contextRecentCount: n });
								else setLocal((prev) => ({ ...prev, contextRecentCount: undefined }));
							},
						})),
				]),
				h('div', { key: 'live', className: 'mtg-row' }, [
					h('div', { key: 'm', className: 'mtg-row-main' }, [
						h('p', { key: 'n', className: 'mtg-row-name' }, '\u4f1a\u573a\u5b9e\u51b5\u600e\u4e48\u663e\u793a'),
						h('p', { key: 'd', className: 'mtg-row-desc' },
							'\u7f51\u9875\u7248\u662f QQ \u7fa4\u6837\u5f0f\u7684\u53ea\u8bfb\u9875\u9762\uff1a\u4e3b\u6301\u4eba\u6709\u4e13\u5c5e\u5934\u50cf\u548c\u300c\u4e3b\u6301\u300d\u5fbd\u6807\uff0c\u53c2\u4f1a\u6210\u5458\u662f\u9ed8\u8ba4\u5934\u50cf\u548c\u300c\u6210\u5458\u300d\u5fbd\u6807\uff0c\u6bcf 2 \u79d2\u81ea\u52a8\u5237\u65b0\u3002\u63a7\u5236\u53f0\u7a97\u53e3\u662f\u65e7\u6837\u5f0f\u3002'),
					]),
					h('div', { key: 'c', className: 'mtg-ctl' },
						h('select', {
							className: 'mtg-num', style: { width: 'auto', minWidth: '100px' },
							value: String(eff.liveMode ?? 'web'),
							disabled: busy === 'liveMode',
							onChange: (e) => save({ liveMode: e.target.value }),
						}, [
							h('option', { key: 'web', value: 'web' }, '\u7f51\u9875\uff08\u63a8\u8350\uff09'),
							h('option', { key: 'cmd', value: 'cmd' }, '\u63a7\u5236\u53f0\u7a97\u53e3'),
							h('option', { key: 'none', value: 'none' }, '\u4e0d\u5f39'),
						])),
				]),
				ToggleRow({
					name: '\u6536\u4f1a\u65f6\u751f\u6210\u4f1a\u8bae\u7eaa\u8981',
					desc: '\u5173\u6389\u4e4b\u540e meeting_close \u7167\u6837\u628a\u6210\u679c\u4ea4\u7ed9\u54e5\u54e5\uff0c\u53ea\u662f\u4e0d\u5f80\u78c1\u76d8\u5199 .md \u6587\u4ef6\u3002',
					on: eff.minutesEnabled !== false,
					busy: busy === 'minutesEnabled',
					onChange: (v) => save({ minutesEnabled: v }),
				}),
				eff.minutesEnabled !== false ? h('div', { key: 'mdir', className: 'mtg-row' }, [
					h('div', { key: 'm', className: 'mtg-row-main' }, [
						h('p', { key: 'n', className: 'mtg-row-name' }, '\u7eaa\u8981\u76ee\u5f55'),
						h('p', { key: 'd', className: 'mtg-row-desc' },
							'\u7eaa\u8981\u5199\u5230\u54ea\u4e2a\u76ee\u5f55\u3002\u7559\u7a7a = \u7528\u63d2\u4ef6\u81ea\u5df1\u7684 minutes/\u3002\u53ea\u6536\u7edd\u5bf9\u8def\u5f84\uff08\u4f8b\u5982 P:\\\\\u4f1a\u8bae\uff09\uff0c\u76f8\u5bf9\u8def\u5f84\u4e00\u5f8b\u62d2\u6536\u3002'),
						h('p', { key: 'cur', className: 'mtg-path' },
							'\u5f53\u524d\uff1a' + String((eff.minutesDir && eff.minutesDir.trim()) || data.minutesDir || '')),
					]),
					h('div', { key: 'c', className: 'mtg-ctl' }, [
						h('input', {
							key: 'i', type: 'text', className: 'mtg-num',
							style: { width: '190px', textAlign: 'left' },
							placeholder: '\u7559\u7a7a = \u9ed8\u8ba4',
							defaultValue: String(cfg.minutesDir || ''),
							disabled: busy === 'minutesDir',
							onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); },
							onBlur: (e) => {
								const v = String(e.target.value || '').trim();
								if (v !== String(cfg.minutesDir || '')) save({ minutesDir: v });
							},
						}),
						pickButton,
					]),
				]) : null,
			];

			const info = [
				h('p', { key: 'd', className: 'mtg-sec' }, '\u6570\u636e\u4f4d\u7f6e'),
				h('p', { key: 'dd', className: 'mtg-path' }, String(data.dir || '')),
				h('p', { key: 'c', className: 'mtg-sec' }, '\u914d\u7f6e\u6587\u4ef6\uff08\u9762\u677f\u6539\u7684\u5c31\u662f\u5b83\uff09'),
				h('p', { key: 'cc', className: 'mtg-path' }, String(data.configFile || '')),
				h('p', { key: 'a', className: 'mtg-sec' }, '\u5f52\u6863\u540d\u5355\uff08\u53ea\u8bfb\uff1a\u5df2\u5c01\u5b58\u7684\u4f1a\u8bdd\u4e0d\u4f1a\u88ab\u9080\u8bf7\uff09'),
				h('p', { key: 'aa', className: 'mtg-path' }, String(data.archiveFile || '')),
			];
			if (Array.isArray(data.sealed) && data.sealed.length > 0) {
				info.push(h('p', { key: 'sl', className: 'mtg-sec' }, '\u5df2\u5c01\u5b58\uff08\u5b89\u606f\uff09'));
				for (const item of data.sealed) {
					info.push(h('p', { key: 's' + item.sessionId, className: 'mtg-path' },
						'\u00b7 ' + (item.title || item.sessionId) + (item.reason ? '\u3000\u2014\u2014' + item.reason : '')));
				}
			}

			return h('div', { className: 'mtg-wrap' }, [
				head,
				h('div', { key: 'st', className: 'mtg-stats' }, chips),
				h('p', { key: 'note', className: 'mtg-note' },
					'\u8fd9\u4e9b\u5f00\u5173\u6539\u5b8c**\u4e0b\u4e00\u6b65\u5c31\u751f\u6548**\uff0c\u4e0d\u9700\u8981\u91cd\u542f DSH\u3002' +
					'\u4f1a\u8bae\u5f00\u8d77\u6765\u4ee5\u540e\u518d\u6539\u4e5f\u7b97\u6570\u3002'),
				h('div', { key: 'rows', className: 'mtg-rows' }, rows),
				h('div', { key: 'info', className: 'mtg-rows' }, info),
			]);
		}

		/**
		 * Client plugin body。
		 * @param ctx - client root context。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.dataset.plugin = 'dsh-xiaoxingchen-meeting';
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => { el.remove(); };
			}, 'dsh-xiaoxingchen-meeting: styles');

			const slots = ctx.get('slots');
			if (slots === undefined) return;
			slots.inject('settings.section', () => slots.register(
				{ name: 'settings.section', id: 'xiaoxingchen-meeting', order: 27, label: '\u661f\u8fb0\u4f1a\u8bae\u5ba4' },
				() => h(MeetingPanel, { ctx }),
			));
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
