export interface Palette { id: string; name: string; colors: string[]; created_at: string; updated_at: string }

export function normalizeHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map((digit) => digit + digit).join('').toUpperCase()}`
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null
}
const colorHex = (channels: number[]) => `#${channels.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`
const components = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))

export function expandGradient(colors: string[], a: number, b: number, count: number): string[] {
  const first = Math.min(a, b), last = Math.max(a, b)
  if (!Number.isInteger(first) || last !== first + 1 || first < 0 || last >= colors.length || !Number.isInteger(count) || count < 2 || count > 1024 || colors.length - 2 + count > 1024) throw new Error('请选择两个相邻色块，生成数量须为 2 至 1024 且总数不超过 1024')
  const left = normalizeHex(colors[first]), right = normalizeHex(colors[last])
  if (!left || !right) throw new Error('色块颜色无效')
  const from = components(left), to = components(right)
  const gradient = Array.from({ length: count }, (_, index) => colorHex(from.map((channel, j) => channel + (to[j] - channel) * index / (count - 1))))
  return [...colors.slice(0, first), ...gradient, ...colors.slice(last + 1)]
}

export function samplePixel(rgba: ArrayLike<number>): string {
  const alpha = rgba[3] / 255
  return colorHex([0, 1, 2].map((index) => rgba[index] * alpha + 255 * (1 - alpha)))
}
