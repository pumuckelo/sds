import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { FieldGroup, Field, FieldLabel, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select'
import { humanize } from '@/lib/api'

export function Choice({ label, value, values, onChange, disabled }: { label: string; value: string; values: readonly string[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select items={values.map(value => ({ value, label: humanize(value) }))} value={value} onValueChange={value => { if (value !== null) onChange(value) }} disabled={disabled}>
    <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent alignItemWithTrigger={false}><SelectGroup>{values.map(value => <SelectItem key={value} value={value}>{humanize(value)}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>
}
export type FormField = { name: string; label: string; multiline?: boolean; placeholder?: string; required?: boolean; initial?: string; choices?: readonly string[] }
export function EditDialog({ title, description, fields, submitLabel = 'Save changes', onClose, onSubmit, children }: {
  title: string; description: string; fields: FormField[]; submitLabel?: string; onClose: () => void; onSubmit: (values: Record<string, string>) => Promise<void>; children?: ReactNode
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(field => [field.name, field.initial ?? field.choices?.[0] ?? ''])))
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <form onSubmit={async event => {
        event.preventDefault(); setPending(true); setError('')
        try { await onSubmit(values); onClose() } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save') } finally { setPending(false) }
      }} className="flex flex-col gap-6">
        <FieldGroup>{fields.map(field => <Field key={field.name} data-disabled={pending}>
          <FieldLabel htmlFor={`field-${field.name}`}>{field.label}</FieldLabel>
          {field.choices ? <Choice label={field.label} value={values[field.name]!} values={field.choices} disabled={pending} onChange={value => setValues(previous => ({ ...previous, [field.name]: value }))} /> : field.multiline ?
            <Textarea id={`field-${field.name}`} value={values[field.name]} placeholder={field.placeholder} required={field.required} disabled={pending} maxLength={100_000} className="min-h-28" onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} /> :
            <Input id={`field-${field.name}`} value={values[field.name]} placeholder={field.placeholder} required={field.required} disabled={pending} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} />}
        </Field>)}</FieldGroup>
        {children}{error && <FieldError>{error}</FieldError>}
        <DialogFooter><Button variant="outline" type="button" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending}>{pending ? 'Saving…' : submitLabel}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
