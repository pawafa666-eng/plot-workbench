import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Plus } from '@/components/ui/icons'
import { api, errorText, remove } from './api'
import type { Palette } from './paletteModel'

export function PaletteLibrary({ onEdit }: { onEdit: (palette?: Palette) => void }) {
  const [palettes, setPalettes] = useState<Palette[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    void api<{ palettes: Palette[] }>('/palettes').then((data) => { if (live) setPalettes(data.palettes) }).catch((e) => { if (live) setError(errorText(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  const visible = palettes.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
  async function deletePalette(item: Palette) {
    if (!window.confirm(`确定删除配色方案「${item.name}」吗？`)) return
    try { await remove(`/palettes/${item.id}`); setPalettes((old) => old.filter((p) => p.id !== item.id)); setError('') } catch (e) { setError(errorText(e)) }
  }
  return <div className="wb-palette-library" data-wb-palette-library><div className="wb-page-heading"><div><h1>配色表</h1><p>收集颜色，让每一张图都有熟悉的配色。</p></div><Button variant="primary" onClick={() => onEdit()} data-palette-create><Plus />创建配色方案</Button></div><div className="wb-palette-heading"><div><h2>我的配色方案</h2><span className="wb-muted">{visible.length} 个方案 · 所有项目可用</span></div><TextInput aria-label="搜索配色方案" type="search" placeholder="搜索配色方案…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>{error && <div className="wb-error" role="alert">{error}</div>}{loading && <div className="wb-loading">正在读取配色方案…</div>}<div className="wb-palette-cards">{visible.map((palette) => <article className="wb-palette-card" key={palette.id} data-palette-card={palette.id}><button className="wb-palette-card-main" onClick={() => onEdit(palette)}><span className="wb-palette-card-colors">{palette.colors.map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span><strong>{palette.name}</strong><span className="wb-muted">{palette.colors.length} 色</span></button><div className="wb-card-footer"><span className="wb-palette-dot-row">{palette.colors.slice(0, 9).map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span><Button onClick={() => void deletePalette(palette)}>删除</Button></div></article>)}</div>{!loading && !visible.length && <div className="wb-palette-empty">{search ? '没有找到匹配的配色方案。' : '还没有配色方案，创建一个开始使用。'}</div>}</div>
}
