import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Dialog } from '@/components/ui/Dialog'
import { api, errorText, post } from './api'
import { expandGradient, normalizeHex, type Palette } from './paletteModel'
import { PaletteImageSampler } from './PaletteImageSampler'

function rgbToHsv(hex: string): [number, number, number] {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min
  let hue = 0
  if (delta) {
    if (max === rgb[0]) hue = ((rgb[1] - rgb[2]) / delta) % 6
    else if (max === rgb[1]) hue = (rgb[2] - rgb[0]) / delta + 2
    else hue = (rgb[0] - rgb[1]) / delta + 4
  }
  return [(hue * 60 + 360) % 360, max ? delta / max : 0, max]
}
function hsvToHex(h: number, s: number, v: number) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return `#${rgb.map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

export function PaletteEditor({ initial, onBack, onSaved, onDirtyChange }: { initial?: Palette; onBack: () => void; onSaved: (palette: Palette) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [colors, setColors] = useState<string[]>(initial?.colors ?? [])
  const [hex, setHex] = useState('#4077CB')
  const [selected, setSelected] = useState<number[]>([])
  const [multi, setMulti] = useState(false)
  const [gradientOpen, setGradientOpen] = useState(false)
  const [count, setCount] = useState('100')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedPalette, setSavedPalette] = useState(initial)
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const liveDraft = useRef('')
  liveDraft.current = JSON.stringify([name, colors])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const initialValue = useRef(JSON.stringify([initial?.name ?? '', initial?.colors ?? []]))
  const dirty = initialValue.current !== JSON.stringify([name, colors])
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault() }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler) }, [dirty])
  const valid = normalizeHex(hex)
  const [h, saturation, value] = rgbToHsv(valid ?? '#4077CB')
  const angle = h * Math.PI / 180
  function wheel(event: PointerEvent<HTMLDivElement>) {
    if (event.buttons !== 1 && event.type !== 'pointerdown') return
    const rect = event.currentTarget.getBoundingClientRect(), dx = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2), dy = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2)
    const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360
    setHex(hsvToHex(hue, Math.min(1, Math.hypot(dx, dy)), value || 1))
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId)
  }
  function choose(index: number) {
    setHex(colors[index]); setSelected((old) => multi ? old.includes(index) ? old.filter((i) => i !== index) : [...old.slice(-1), index] : [index])
  }
  async function save(asNew = false) {
    if (!name.trim() || !colors.length || saving) return
    const targetName = asNew ? window.prompt('另存为的名称', `${name} 副本`)?.trim() : name.trim()
    if (!targetName) return
    const submitted = JSON.stringify([name, colors])
    setSaving(true); setError(''); setNotice('')
    try {
      const payload = { name: targetName, colors }
      const result = savedPalette && !asNew ? await api<Palette>(`/palettes/${savedPalette.id}`, { method: 'PUT', body: JSON.stringify(payload) }) : await post<Palette>('/palettes', payload)
      if (!alive.current) return
      if (!asNew) { initialValue.current = JSON.stringify([result.name, result.colors]); setSavedPalette(result) }
      if (liveDraft.current === submitted) onSaved(result)
      else setNotice(asNew ? `已另存为「${result.name}」，当前后续修改仍未保存。` : '已保存提交时的内容，后续修改仍未保存。')
    } catch (e) { if (alive.current) setError(errorText(e)) } finally { if (alive.current) setSaving(false) }
  }
  function add() { if (!valid || colors.length >= 1024) return; setColors([...colors, valid]); setSelected([colors.length]) }
  function replace() { if (!valid || selected.length !== 1) return; setColors(colors.map((c, i) => i === selected[0] ? valid : c)) }
  function remove() { if (!selected.length) return; setColors(colors.filter((_, i) => !selected.includes(i))); setSelected([]) }
  function gradient() { try { setColors(expandGradient(colors, selected[0], selected[1], Number(count))); setSelected([]); setGradientOpen(false); setError('') } catch (e) { setError(errorText(e)) } }
  return <div className="wb-palette-editor" data-wb-palette-editor>
    <div className="wb-page-heading"><div><h1>{savedPalette ? '编辑配色方案' : '创建配色方案'}</h1><p>将喜欢的颜色收集成可以在图中反复使用的方案。</p></div><div className="wb-toolbar"><Button onClick={() => { if (!dirty || window.confirm('配色方案尚未保存，确定离开吗？')) onBack() }}>返回</Button>{savedPalette && <Button variant="secondary" disabled={saving || !colors.length || !name.trim()} onClick={() => void save(true)}>另存为</Button>}<Button variant="primary" disabled={saving || !colors.length || !name.trim()} onClick={() => void save()} data-palette-save>保存方案</Button></div></div>
    {error && <div className="wb-error" role="alert">{error}</div>}{notice && <div className="wb-notice" role="status">{notice}</div>}
    <div className="wb-palette-name"><label>方案名称<TextInput aria-label="方案名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：论文蓝橙" data-palette-name /></label><span>{colors.length} / 1024 色</span></div>
    <div className="wb-palette-workspace"><section className="wb-palette-controls"><div className="wb-palette-section-title"><span>01</span><div><h2>选择颜色</h2><p>输入色号，或在色轮上选择。</p></div></div><div className="wb-color-wheel" role="slider" tabIndex={0} aria-label="色轮" aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(h)} aria-valuetext={valid ?? hex} onPointerDown={wheel} onPointerMove={wheel} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setHex(hsvToHex((h + (event.key === 'ArrowRight' ? 5 : 355)) % 360, saturation || 1, value || 1)) } }} style={{ filter: `brightness(${Math.max(value, 0.02)})` }}><span className="wb-wheel-marker" style={{ left: `${50 + 48 * saturation * Math.cos(angle)}%`, top: `${50 + 48 * saturation * Math.sin(angle)}%` }} /></div><label className="wb-palette-brightness">明度<input type="range" min="0" max="100" value={Math.round(value * 100)} onChange={(e) => setHex(hsvToHex(h, saturation, Number(e.target.value) / 100))} /></label><div className="wb-palette-hex"><span style={{ background: valid ?? 'transparent' }} /><TextInput aria-label="颜色代码" value={hex} onChange={(e) => setHex(e.target.value)} onBlur={() => { if (valid) setHex(valid) }} data-palette-hex /><input type="color" aria-label="系统颜色选择器" value={valid ?? '#4077CB'} onChange={(e) => setHex(e.target.value.toUpperCase())} /></div>{!valid && <p className="wb-error">请输入有效的十六进制颜色，例如 #2765A8。</p>}<div className="wb-toolbar"><Button variant="primary" disabled={!valid || colors.length >= 1024} onClick={add} data-palette-add>添加色块</Button><Button variant="secondary" disabled={!valid || selected.length !== 1} onClick={replace} data-palette-replace>替换色块</Button></div></section>
    <section className="wb-palette-swatches"><div className="wb-palette-section-title"><span>02</span><div><h2>已选颜色</h2><p>选择色块可修改，选择两个相邻色块可生成渐变。</p></div></div><div className="wb-palette-actions"><Button data-palette-multiselect active={multi} onClick={() => { setMulti(!multi); setSelected([]) }}>选择两个色块</Button><Button data-palette-delete disabled={!selected.length} onClick={remove}>删除色块</Button><Button data-palette-gradient variant="secondary" disabled={selected.length !== 2 || Math.abs(selected[0] - selected[1]) !== 1} onClick={() => { setError(''); setGradientOpen(true) }}>制作渐变色</Button></div><div className="wb-palette-swatch-grid">{colors.map((color, index) => <button key={index} className={`wb-palette-swatch ${selected.includes(index) ? 'is-selected' : ''}`} onClick={() => choose(index)} data-palette-swatch={index} aria-label={`色块 ${index + 1} ${color}`} aria-pressed={selected.includes(index)}><span style={{ background: color }} /><small>{color}</small></button>)}</div>{!colors.length && <div className="wb-palette-empty">从左侧添加第一个颜色，开始创建配色。</div>}</section></div>
    <PaletteImageSampler onPick={(color) => setHex(color)} />
    {gradientOpen && <Dialog open title="制作渐变色" description="总色块数量包含所选的两个端点。" onOpenChange={(open) => { if (!open) setGradientOpen(false) }} footer={<><Button onClick={() => setGradientOpen(false)}>取消</Button><Button data-palette-gradient-confirm variant="primary" onClick={gradient}>生成渐变</Button></>}><label className="wb-field">总色块数量<input data-palette-gradient-count type="number" min="2" max="1024" value={count} onChange={(event) => setCount(event.target.value)} /></label>{error && <p className="wb-error" role="alert">{error}</p>}</Dialog>}
  </div>
}
