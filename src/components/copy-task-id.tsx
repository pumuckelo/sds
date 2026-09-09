import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CopyTaskId({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <span className="inline-flex items-center gap-1">
    <Button variant="ghost" size="icon-xs" aria-label={`Copy task ID ${id}`} title={state === 'copied' ? 'Copied full task ID' : 'Copy full task ID'} onClick={async event => {
      event.stopPropagation()
      clearTimeout(timer.current)
      try { await navigator.clipboard.writeText(id); setState('copied') }
      catch { setState('error') }
      timer.current = setTimeout(() => setState('idle'), 2000)
    }}>{state === 'copied' ? <Check /> : <Copy />}</Button>
    <span role="status" className={state === 'error' ? 'text-xs text-destructive' : 'sr-only'}>{state === 'copied' ? 'Task ID copied' : state === 'error' ? 'Copy failed' : ''}</span>
  </span>
}
