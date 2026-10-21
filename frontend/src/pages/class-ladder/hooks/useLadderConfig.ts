import { useEffect, useState } from 'react'
import { getLadderConfig } from '../../../api/classLadder'
import type { LadderConfig } from '../../../api/classLadder'
import { reportLoadError } from '../../../utils/loadError'

/** 服务端闯关配置（皮肤 / 阶梯 / 锦囊 / 题型 / 限时档位等），失败只报一次不阻塞 */
export function useLadderConfig() {
  const [config, setConfig] = useState<LadderConfig | null>(null)
  useEffect(() => {
    getLadderConfig()
      .then(setConfig)
      .catch((e) => reportLoadError(e, { key: 'classladder-config' }))
  }, [])
  return config
}
