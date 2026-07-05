import { useModals } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'

function resolveAfterModalClose<T>(resolve: (value: T) => void, value: T) {
  setTimeout(() => resolve(value), 0)
}

export const useAskForArchivePassword = () => {
  const { $gettext } = useGettext()
  const { dispatchModal, updateModal } = useModals()

  function askForArchivePassword(): Promise<string | null> {
    return new Promise((resolve) => {
      let modalId = ''
      const modal = dispatchModal({
        title: $gettext('Encrypted archive'),
        message: $gettext('Enter the archive password to extract its files.'),
        confirmText: $gettext('Extract'),
        hasInput: true,
        inputType: 'password',
        inputValue: '',
        inputLabel: $gettext('Archive password'),
        inputRequiredMark: true,
        confirmDisabled: true,
        onInput: (value: string, setError: (error: string) => void) => {
          const isEmpty = !value
          setError(isEmpty ? $gettext('Password is required') : '')
          updateModal(modalId, 'confirmDisabled', isEmpty)
        },
        onConfirm: (value: string) => {
          resolveAfterModalClose(resolve, value || null)
        },
        onCancel: () => {
          resolveAfterModalClose(resolve, null)
        }
      })
      modalId = modal.id
    })
  }

  return {
    askForArchivePassword
  }
}
