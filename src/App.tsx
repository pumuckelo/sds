import { useCallback, useEffect, useState } from 'react'
import { Plus, FolderGit2, GitBranch, ArrowUpRight, Layers3, CircleCheck, CircleDashed, CircleDot, ShieldCheck, Cable, RefreshCw, Activity, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { EditDialog, Choice } from '@/components/forms'
import { TaskDetail } from '@/components/task-detail'
import { api, timeAgo, humanize, type CheckoutView, type TaskList, type TaskView } from '@/lib/api'
import { cn } from '@/lib/utils'

function readRoute() {
  const match = location.pathname.match(/^\/checkouts\/([A-Za-z0-9_-]+)(?:\/tasks\/([A-Za-z0-9_-]+))?\/?$/)
  return { checkoutId: match?.[1] ?? '', taskId: match?.[2] ?? '' }
}
const stageMeta = [{ id: 'planning', title: 'Planning', subtitle: 'Shape the work', icon: CircleDashed }, { id: 'implementing', title: 'Implementing', subtitle: 'Make it happen', icon: CircleDot }, { id: 'reviewing', title: 'Reviewing', subtitle: 'Verify and refine', icon: ShieldCheck }] as const
export default function App() {
  const [route, setRoute] = useState(readRoute), [version, setVersion] = useState(0)
  const [checkouts, setCheckouts] = useState<CheckoutView[]>([]), [tasks, setTasks] = useState<TaskList['items']>([]), [task, setTask] = useState<TaskView | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [connected, setConnected] = useState(false)
  const [dialog, setDialog] = useState<'register' | 'create' | 'connect' | null>(null)
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all')
  const refresh = useCallback(() => setVersion(version => version + 1), [])
  const navigate = useCallback((checkoutId: string, taskId = '', replace = false) => {
    history[replace ? 'replaceState' : 'pushState']({}, '', checkoutId ? `/checkouts/${checkoutId}${taskId ? `/tasks/${taskId}` : ''}` : '/')
    setRoute({ checkoutId, taskId }); setTask(null); setLoading(true); setError('')
  }, [])
  useEffect(() => { const onPop = () => { setRoute(readRoute()); setTask(null); setLoading(true) }; addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop) }, [])
  useEffect(() => {
    const events = new EventSource('/events')
    let debounce: ReturnType<typeof setTimeout>
    events.onopen = () => setConnected(true)
    events.onerror = () => setConnected(false)
    events.addEventListener('change', () => { clearTimeout(debounce); debounce = setTimeout(refresh, 120) })
    return () => { events.close(); clearTimeout(debounce) }
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const entries = await api<CheckoutView[]>('checkouts', undefined, controller.signal)
        setCheckouts(entries)
        if (!route.checkoutId && entries.some(entry => entry.available)) { navigate(entries.find(entry => entry.available)!.id, '', true); return }
        const current = entries.find(entry => entry.id === route.checkoutId)
        if (route.checkoutId && !current) throw new Error('This checkout is not registered on this machine.')
        if (current && !current.available) throw new Error(current.error ?? 'Checkout is unavailable')
        if (route.checkoutId) {
          // Follow pagination so large repositories never silently disappear from the board.
          let offset: number | null = 0; const all: TaskList['items'] = []
          while (offset !== null) {
            const page: TaskList = await api('tasks/list', { checkoutId: route.checkoutId, offset, limit: 100 }, controller.signal)
            all.push(...page.items); offset = page.nextOffset
          }
          setTasks(all)
          if (route.taskId) setTask(await api<TaskView>('tasks/get', { checkoutId: route.checkoutId, taskId: route.taskId, view: 'full' }, controller.signal))
        } else { setTasks([]); setTask(null) }
        setError('')
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Cannot reach SDS') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [version, route.checkoutId, route.taskId, navigate])
  const checkout = checkouts.find(entry => entry.id === route.checkoutId)
  const groups = new Map<string, CheckoutView[]>()
  for (const entry of checkouts) groups.set(entry.projectId, [...(groups.get(entry.projectId) ?? []), entry])
  const visible = tasks.filter(task => (status === 'all' || task.status === status) && task.title.toLowerCase().includes(search.toLowerCase()))
  const active = tasks.filter(task => task.status === 'active').length, done = tasks.filter(task => task.status === 'done').length, blocked = tasks.filter(task => task.status === 'blocked').length
  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="brand" onClick={event => { event.preventDefault(); navigate('') }}><span className="brand-symbol"><Layers3 className="size-5" /></span><strong>sds<span className="brand-period">.</span></strong><span className="brand-caption">AGENT WORKSPACE</span></a>
      <div className="sidebar-top"><span className="eyebrow">YOUR PROJECTS</span><Button variant="ghost" size="icon-sm" aria-label="Register project" onClick={() => setDialog('register')}><Plus /></Button></div>
      <nav aria-label="Projects" className="project-nav">{[...groups].map(([id, entries]) => <div key={id} className="project-group"><div className="project-name"><FolderGit2 className="size-4" /><span>{entries[0]?.projectName}</span></div>{entries.map(entry => <button key={entry.id} className={cn('checkout-link', route.checkoutId === entry.id && 'selected')} onClick={() => navigate(entry.id)}><GitBranch className="size-3.5" /><span className="truncate">{entry.branch || entry.name}</span>{!entry.available && <AlertCircle className="size-3.5" />}{route.checkoutId === entry.id && <span className="selection-dot" />}</button>)}</div>)}</nav>
      {checkouts.length === 0 && <p className="sidebar-hint">Connect a local folder to bring your agents’ work into view.</p>}
      <Button className="mx-4 mt-3" variant="outline" onClick={() => setDialog('register')}><Plus data-icon="inline-start" />Register project</Button>
      <div className="sidebar-bottom"><div className="local-note"><span className={cn('connection-dot', connected && 'online')} /><span>{connected ? 'Connected to local server' : 'Reconnecting to server'}</span></div><Separator /><Button variant="ghost" className="w-full justify-start" onClick={() => setDialog('connect')}><Cable data-icon="inline-start" />Connect an agent<ArrowUpRight data-icon="inline-end" /></Button><p>Local files. Shared context.<br />Your workflow, any harness.</p></div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div className="flex items-center gap-2 min-w-0"><FolderGit2 className="size-4 text-muted-foreground" /><span className="truncate">{checkout?.projectName ?? 'Workspace'}</span>{checkout && <><span className="text-muted-foreground">/</span><span className="text-muted-foreground truncate">{checkout.branch ?? checkout.name}</span></>}</div><div className="flex items-center gap-3"><Badge variant="outline">Local workspace</Badge><Button variant="ghost" size="icon-sm" aria-label="Refresh workspace" onClick={refresh}><RefreshCw /></Button></div></header>
      <div className="workspace-content">
        {error && <Alert variant="destructive" className="mb-6"><AlertCircle /><AlertTitle>Unable to load workspace</AlertTitle><AlertDescription>{error} <button className="underline" onClick={refresh}>Retry</button></AlertDescription></Alert>}
        {loading && !task && tasks.length === 0 ? <div className="flex flex-col gap-6" aria-label="Loading workspace"><Skeleton className="h-10 w-56" /><Skeleton className="h-24 w-full" /><div className="grid grid-cols-3 gap-5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-64" />)}</div></div> : route.taskId ? task ? <TaskDetail key={`${route.checkoutId}/${task.id}`} task={task} checkoutId={route.checkoutId} onBack={() => navigate(route.checkoutId)} refresh={refresh} /> : null : !checkout ? <Empty className="welcome"><EmptyHeader><EmptyMedia variant="icon"><Layers3 /></EmptyMedia><EmptyTitle>Give your agents a shared workspace.</EmptyTitle><EmptyDescription>Plan, implement, and review in one place. Your tasks stay in your repository, ready for any agent.</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => setDialog('register')}><Plus data-icon="inline-start" />Register your first project</Button><Button variant="link" onClick={() => setDialog('connect')}>Set up an agent connection</Button></EmptyContent></Empty> : <>
          <div className="board-heading"><div><div className="eyebrow">PROJECT OVERVIEW</div><h1>The work, in motion<span>.</span></h1><p>A shared view of what your agents are building.</p></div><Button size="lg" onClick={() => setDialog('create')} disabled={!checkout.available}><Plus data-icon="inline-start" />New task</Button></div>
          <div className="stats-strip"><div><span className="stat-label">Total tasks</span><strong>{tasks.length.toString().padStart(2, '0')}</strong><Layers3 /></div><div><span className="stat-label">In progress</span><strong>{active.toString().padStart(2, '0')}</strong><Activity /></div><div><span className="stat-label">Completed</span><strong>{done.toString().padStart(2, '0')}</strong><CircleCheck /></div><div><span className="stat-label">Needs attention</span><strong>{blocked.toString().padStart(2, '0')}</strong><AlertCircle /></div></div>
          <div className="board-toolbar"><div className="flex gap-2 items-center"><h2>Task board</h2><Badge variant="secondary">{visible.length}</Badge></div><div className="flex flex-wrap items-center gap-2"><Input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={event => setSearch(event.target.value)} className="w-48" /><Choice label="Filter by status" value={status} values={['all', 'queued', 'active', 'blocked', 'done', 'cancelled']} onChange={setStatus} /></div></div>
          <div className="kanban">{stageMeta.map(stage => {
            const items = visible.filter(task => task.stage === stage.id)
            return <section className="kanban-column" key={stage.id}><div className="column-heading"><stage.icon className="size-4" /><h3>{stage.title}</h3><span>{items.length}</span></div><p className="column-subtitle">{stage.subtitle}</p><div className="column-tasks">{items.map(task => <button className={cn('task-card', task.status === 'done' && 'completed')} key={task.id} onClick={() => navigate(route.checkoutId, task.id)}><div className="task-card-meta"><code>{task.ref}</code><Badge variant={task.status === 'blocked' ? 'destructive' : task.status === 'active' ? 'default' : 'secondary'}>{humanize(task.status)}</Badge></div><h4>{task.title}</h4><div className="task-card-progress"><div><span style={{ width: `${task.todoCount ? task.completedTodos / task.todoCount * 100 : 0}%` }} /></div><span>{task.completedTodos}/{task.todoCount}</span></div><div className="task-card-footer"><span>{task.activity.running ? 'Agent working' : `Updated ${timeAgo(task.updatedAt)}`}</span>{task.openFindings > 0 ? <span className="finding-count"><ShieldCheck className="size-3.5" />{task.openFindings}</span> : <ArrowUpRight className="size-3.5" />}</div></button>)}{items.length === 0 && <Empty className="column-empty"><EmptyHeader><EmptyTitle>{search || status !== 'all' ? 'No matching tasks' : 'Nothing here yet'}</EmptyTitle><EmptyDescription>{stage.id === 'planning' ? 'Every good build starts with a plan.' : stage.id === 'implementing' ? 'Tasks appear here when building begins.' : 'Ready for a second pair of eyes.'}</EmptyDescription></EmptyHeader></Empty>}</div></section>
          })}</div><footer className="board-footer"><span className="flex items-center gap-2"><span className={cn('connection-dot', connected && 'online')} />{connected ? 'Updates as your agents work' : 'Waiting for connection'}</span><span title={checkout.path} className="truncate">{checkout.path}/.agent-work</span></footer>
        </>}
      </div>
    </main>
    {dialog === 'register' && <EditDialog title="Register a project" description="Choose a local checkout. SDS stores tasks in its .agent-work folder." fields={[{ name: 'path', label: 'Absolute folder path', placeholder: '/Users/you/projects/my-app', required: true }, { name: 'name', label: 'Display name (optional)', placeholder: 'My app' }]} submitLabel="Register project" onClose={() => setDialog(null)} onSubmit={async values => { const entry = await api<{ id: string }>('checkouts', { path: values.path, ...(values.name ? { name: values.name } : {}) }); navigate(entry.id); refresh() }} />}
    {dialog === 'create' && checkout && <EditDialog title="Create a task" description={`Add a task to ${checkout.projectName}. Agents can flesh out the plan.`} fields={[{ name: 'title', label: 'Task name', required: true, placeholder: 'What needs to be built?' }, { name: 'description', label: 'Description · Markdown supported', multiline: true, placeholder: 'The goal, constraints, and what done looks like.' }, { name: 'todos', label: 'Initial todos (one per line)', multiline: true, placeholder: 'Optional first steps' }]} submitLabel="Create task" onClose={() => setDialog(null)} onSubmit={async values => { const result = await api<{ id: string }>('tasks/create', { checkoutId: checkout.id, title: values.title, description: values.description, todos: values.todos!.split('\n').map(title => title.trim()).filter(Boolean).map(title => ({ title })) }); navigate(checkout.id, result.id); refresh() }} />}
    {dialog === 'connect' && <Dialog open onOpenChange={open => { if (!open) setDialog(null) }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Bring your agent into the loop</DialogTitle><DialogDescription>Add this Streamable HTTP MCP server to your harness.</DialogDescription></DialogHeader><pre className="connection-code">{JSON.stringify({ mcpServers: { sds: { url: `${location.port === '5173' ? 'http://127.0.0.1:4317' : location.origin}/mcp` } } }, null, 2)}</pre><p className="text-sm text-muted-foreground">Your harness may use a different configuration shape. Select Streamable HTTP and use the URL above.</p><Separator /><p className="text-sm">Start with <code>checkout_list</code> or <code>checkout_register</code>, then use the returned checkout ID on every task call.</p>{checkout && <p className="text-sm break-all">Current checkout: <code>{checkout.id}</code></p>}</DialogContent></Dialog>}
  </div>
}
