import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { samplePixel } from './paletteModel'

export function PaletteImageSampler({ onPick }: { onPick: (color: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const source = useRef<HTMLCanvasElement | null>(null)
  const request = useRef(0)
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [picking, setPicking] = useState(false)
  const [hover, setHover] = useState<{ x: number; y: number; color: string; preview: string } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url) }, [image])
  useEffect(() => () => { request.current++ }, [])
  async function load(file?: File) {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('请选择图片文件。'); return }
    const token = ++request.current, url = URL.createObjectURL(file)
    try {
      const img = new Image(); img.src = url
      await img.decode()
      if (token !== request.current) { URL.revokeObjectURL(url); return }
      if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 64_000_000) throw new Error('图片过大，请选择不超过 6400 万像素的图片。')
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('无法读取图片像素。')
      ctx.drawImage(img, 0, 0)
      // Freeze the visible image to exactly the decoded frame used for sampling.
      // Animated GIF/WebP must not keep playing while the sampling canvas stays still.
      const frozen = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法读取图片像素。')), 'image/png'))
      URL.revokeObjectURL(url)
      if (token !== request.current) return
      const frozenUrl = URL.createObjectURL(frozen)
      source.current = canvas
      setImage({ url: frozenUrl, width: canvas.width, height: canvas.height }); setZoom(1); setHover(null); setPicking(true); setError('')
    } catch (e) { URL.revokeObjectURL(url); if (token === request.current) setError(e instanceof Error ? e.message : '图片无法读取。') }
  }
  function point(event: PointerEvent<HTMLImageElement>, commit = false) {
    const canvas = source.current
    if (!image || !canvas || !picking) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) * canvas.width / rect.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) * canvas.height / rect.height)))
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return
    const color = samplePixel(ctx.getImageData(x, y, 1, 1).data)
    if (commit) { onPick(color); return }
    const small = document.createElement('canvas'); small.width = 11; small.height = 11
    const smallCtx = small.getContext('2d'); if (!smallCtx) return
    smallCtx.fillStyle = '#fff'; smallCtx.fillRect(0, 0, 11, 11)
    smallCtx.drawImage(canvas, x - 5, y - 5, 11, 11, 0, 0, 11, 11)
    setHover({ x: event.clientX, y: event.clientY, color, preview: small.toDataURL() })
  }
  return <section className="wb-palette-image" data-palette-image-drop onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void load(event.dataTransfer.files[0]) }}>
    <div className="wb-palette-section-title"><span>03</span><div><h2>从图片取色</h2><p>图片只在本机处理，选择颜色后可添加到方案。</p></div><div className="wb-toolbar"><input hidden ref={fileInput} data-palette-image-upload type="file" accept="image/*" onChange={(event) => { void load(event.target.files?.[0]); event.currentTarget.value = '' }} /><Button variant="secondary" onClick={() => fileInput.current?.click()}>选择图片</Button>{image && <><Button active={picking} onClick={() => { setPicking(!picking); setHover(null) }}>取色笔</Button><Button onClick={() => { request.current++; source.current = null; setImage(null); setHover(null) }}>关闭图片</Button></>}</div></div>
    {error && <p className="wb-error" role="alert">{error}</p>}
    {!image ? <div className="wb-palette-drop" onClick={() => fileInput.current?.click()}>拖入图片到这里，或点击选择图片</div> : <><label className="wb-palette-zoom">图片缩放 <input type="range" min="25" max="300" value={zoom * 100} onChange={(e) => setZoom(Number(e.target.value) / 100)} /> {Math.round(zoom * 100)}%</label><div className="wb-palette-image-viewport"><img src={image.url} alt="用于取色的图片" style={{ width: `${Math.max(320, Math.min(image.width, 900)) * zoom}px`, maxWidth: 'none', cursor: picking ? 'crosshair' : 'default' }} onPointerMove={(event) => point(event)} onPointerLeave={() => setHover(null)} onClick={(event) => point(event as unknown as PointerEvent<HTMLImageElement>, true)} /></div></>}
    {hover && <div className="wb-palette-magnifier" data-palette-magnifier style={{ left: Math.min(hover.x + 18, window.innerWidth - 150), top: Math.min(hover.y + 18, window.innerHeight - 170) }}><div style={{ backgroundImage: `url(${hover.preview})` }}><span /></div><strong>{hover.color}</strong></div>}
  </section>
}
