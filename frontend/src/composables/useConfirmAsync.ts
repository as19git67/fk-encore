import { useConfirm } from 'primevue/useconfirm'

/**
 * PrimeVue's ConfirmDialog as a promise, for handlers that used to read
 * `if (!window.confirm(…)) return`. The browser dialog ignores the app's
 * theme and focus rules (CLAUDE.md, "Dialoge"); this keeps the call site as
 * short while going through the one ConfirmDialog in App.vue.
 */
export interface ConfirmAsyncOptions {
  header: string
  message: string
  /** Label of the accepting button; names the action ("Löschen", "Ablehnen"). */
  acceptLabel: string
  /** A destructive action gets the danger button and the warning icon. */
  danger?: boolean
}

export function useConfirmAsync() {
  const confirm = useConfirm()
  return (opts: ConfirmAsyncOptions): Promise<boolean> =>
    new Promise((resolve) => {
      confirm.require({
        header: opts.header,
        message: opts.message,
        icon: opts.danger ? 'pi pi-exclamation-triangle' : 'pi pi-question-circle',
        rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
        acceptProps: { label: opts.acceptLabel, severity: opts.danger ? 'danger' : undefined },
        accept: () => resolve(true),
        reject: () => resolve(false),
        onHide: () => resolve(false),
      })
    })
}
