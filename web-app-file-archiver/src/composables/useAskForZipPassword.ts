import { useModals } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'

function resolveAfterModalClose<T>(resolve: (value: T) => void, value: T) {
  setTimeout(() => resolve(value), 0)
}

export const useAskForZipPassword = () => {
  const { $gettext } = useGettext()
  const { dispatchModal, updateModal } = useModals()

  const askForZipPassword = (): Promise<string | null> => {
    return new Promise((resolve) => {
      let modalId = ''
      const modal = dispatchModal({
        title: $gettext('Create encrypted ZIP archive'),
        message: $gettext('Enter a password to protect the ZIP archive.'),
        confirmText: $gettext('Create'),
        hasInput: true,
        inputType: 'password',
        inputValue: '',
        inputLabel: $gettext('ZIP password'),
        inputDescription: $gettext('This password will be required to open files in the archive.'),
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
    askForZipPassword
  }
}
