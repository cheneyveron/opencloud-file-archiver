import { useModals } from '@opencloud-eu/web-pkg'
import { defaultComponentMocks, getComposableWrapper } from '@opencloud-eu/web-test-helpers'
import { useAskForZipPassword } from '../../../src/composables/useAskForZipPassword'

describe('ask for zip password', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the current modal can close', async () => {
    const askForZipPassword = getAskForZipPassword()
    const { dispatchModal } = useModals()
    vi.mocked(dispatchModal).mockImplementation((modal) => ({ ...modal, id: 'modal-id' }))

    const promise = askForZipPassword()
    let resolved = false
    promise.then(() => {
      resolved = true
    })

    const modal = vi.mocked(dispatchModal).mock.calls[0][0]
    modal.onConfirm?.('zip-password')

    await Promise.resolve()
    expect(resolved).toBe(false)

    vi.runOnlyPendingTimers()
    await expect(promise).resolves.toBe('zip-password')
  })
})

function getAskForZipPassword() {
  const mocks = { ...defaultComponentMocks() }
  let askForZipPassword!: () => Promise<string | null>
  getComposableWrapper(
    () => {
      askForZipPassword = useAskForZipPassword().askForZipPassword
    },
    {
      mocks,
      provide: mocks
    }
  )
  return askForZipPassword
}
