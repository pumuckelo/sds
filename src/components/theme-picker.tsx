import { useEffect, useState } from 'react'
import { Choice } from './forms'

export function ThemePicker() {
  const [theme, setTheme] = useState(() => { try { const saved = localStorage.getItem('sds-theme'); return saved === 'light' || saved === 'dark' ? saved : 'system' } catch { return 'system' } })
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches))
    apply(); try { localStorage.setItem('sds-theme', theme) } catch { /* Storage is optional. */ }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  return <Choice label="Color theme" value={theme} values={['system', 'light', 'dark']} onChange={setTheme} />
}
