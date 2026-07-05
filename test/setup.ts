import { afterEach, vi } from 'vitest'

const clients = new Set<{ close(): void }>()

vi.mock('../src/client.js', async (importOriginal) => {
  const clientModule = await importOriginal<typeof import('../src/client.js')>()
  const valtioSync: typeof clientModule.valtioSync = (...args) => {
    const client = clientModule.valtioSync(...args)
    const close = client.close.bind(client)
    let closed = false

    client.close = () => {
      if (closed) {
        return
      }

      closed = true
      clients.delete(client)
      close()
    }

    clients.add(client)
    return client
  }

  return {
    ...clientModule,
    valtioSync,
  }
})

afterEach(() => {
  for (const client of [...clients]) {
    client.close()
  }
  clients.clear()
  vi.useRealTimers()
})
