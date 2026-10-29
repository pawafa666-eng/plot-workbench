import { createContext, useContext, useState } from 'react'
import type { Palette } from '@/workbench/paletteModel'
import { Popover } from './Popover'
import { useTranslation } from 'react-i18next'
import { gradientOfStops } from '@/components/inspector/controls/colormapStops'
export const PaletteContext = createContext<{ palettes: Palette[]; error: string } | null>(null)
export type PaletteMap = { kind: 'workbench_palette_v1'; mode: 'continuous' | 'discrete'; colors: string[] }
export function paletteMapName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const map = value as Partial<PaletteMap>
  if (map.kind !== 'workbench_palette_v1' || (map.mode !== 'continuous' && map.mode !== 'discrete') || !Array.isArray(map.colors) || map.colors.length < 2 || map.colors.length > 1024 || !map.colors.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))) return null
  return `pwb1-${map.mode}-${map.colors.map((color) => color.slice(1).toUpperCase()).join('')}`
}
export function PalettePicker({ onColor, onMap }: { onColor?: (color: string) => void; onMap?: (value: PaletteMap) => void }) {
  const { t } = useTranslation()
  const source = useContext(PaletteContext)
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState('')
  const [mode, setMode] = useState<'continuous' | 'discrete'>('continuous')
  if (!source) return null
  const palette = source.palettes.find((item) => item.id === chosen) ?? source.palettes[0]
  return <span className="wb-inline-palette"><Popover width={240} open={open} onOpenChange={setOpen} trigger={<button type="button" className="wb-inline-palette-trigger" data-palette-picker>{t('palettePicker.title')}</button>}>
    <div className="wb-inline-palette-pop" data-palette-picker-panel>
      {source.error ? <p className="wb-error">{source.error}</p> : !palette ? <p>{t('palettePicker.empty')}</p> : <>
        <select aria-label={t('palettePicker.choose')} value={palette.id} onChange={(e) => setChosen(e.target.value)}>{source.palettes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {onColor && <div className="wb-inline-palette-colors">{palette.colors.map((color, index) => <button type="button" key={index} title={color} aria-label={color} data-palette-color={color} style={{ background: color }} onClick={() => { onColor(color); setOpen(false) }} />)}</div>}
        {onMap && <><div className="wb-inline-palette-ramp" data-palette-ramp={mode} style={{ background: gradientOfStops(palette.colors, mode === 'discrete') ?? undefined }} /><select aria-label={t('palettePicker.mode')} value={mode} onChange={(e) => setMode(e.target.value as 'continuous' | 'discrete')}><option value="continuous">{t('palettePicker.continuous')}</option><option value="discrete">{t('palettePicker.discrete')}</option></select><button type="button" disabled={palette.colors.length < 2} onClick={() => { onMap({ kind: 'workbench_palette_v1', mode, colors: [...palette.colors] }); setOpen(false) }}>{t('palettePicker.apply')}</button>{palette.colors.length < 2 && <p>{t('palettePicker.tooFew')}</p>}</>}
      </>}
    </div>
  </Popover></span>
}
