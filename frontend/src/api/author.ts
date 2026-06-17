/** API 封装 */
import apiClient from './client'

export async function getDeployments() {
  const { data } = await apiClient.get('/api/config-sync/nodes')
  return data
}

export async function getPhoneHomeStats() {
  const { data } = await apiClient.get('/api/config-sync/summary')
  return data
}
