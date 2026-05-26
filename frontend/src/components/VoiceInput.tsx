/**
 * 语音输入组件
 * 使用 Web Speech API (SpeechRecognition) 将语音转为文字
 */
import React, { useRef, useState, useCallback, useEffect } from 'react'
import { Button, Tooltip, message } from 'antd'
import { AudioOutlined, StopOutlined } from '@ant-design/icons'

// SpeechRecognition 类型声明（部分浏览器尚未纳入 TypeScript 标准库）
interface SpeechRecognitionInstance {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionEvent {
  resultIndex: number
  results: SpeechRecognitionResult[]
}

interface SpeechRecognitionResult {
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent {
  error: string
  message?: string
}

interface VoiceInputProps {
  onTranscript: (text: string) => void
  disabled?: boolean
}

// 检查浏览器是否支持 SpeechRecognition
const SpeechRecognitionAPI:
  | (new () => SpeechRecognitionInstance)
  | undefined = (() => {
    const w = window as unknown as Record<string, unknown>
    return (
      (w.SpeechRecognition as new () => SpeechRecognitionInstance)
      || (w.webkitSpeechRecognition as new () => SpeechRecognitionInstance)
      || undefined
    )
  })()

const VoiceInput: React.FC<VoiceInputProps> = ({ onTranscript, disabled }) => {
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const [listening, setListening] = useState(false)
  const [supported] = useState(() => !!SpeechRecognitionAPI)

  // 开始语音识别
  const startListening = useCallback(() => {
    if (!SpeechRecognitionAPI) return

    // 如果已有识别实例，先停止
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }

    const recognition = new SpeechRecognitionAPI()
    recognition.lang = 'zh-CN'            // 中文普通话
    recognition.continuous = true          // 连续识别
    recognition.interimResults = true      // 返回中间结果
    recognition.maxAlternatives = 1

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalTranscript += result[0].transcript
        }
      }

      // 有最终结果时立即回填
      if (finalTranscript) {
        onTranscript(finalTranscript)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('语音识别错误:', event.error)
      setListening(false)

      switch (event.error) {
        case 'not-allowed':
        case 'permission-denied':
          message.warning('麦克风权限被拒绝，请在浏览器设置中允许麦克风访问')
          break
        case 'no-speech':
          // 无语音输入时静默处理，不提示
          break
        case 'audio-capture':
          message.warning('未检测到麦克风设备')
          break
        case 'network':
          message.warning('语音识别网络错误，请检查网络连接')
          break
        case 'aborted':
          // 用户手动停止，不提示
          break
        default:
          message.warning(`语音识别错误: ${event.error}`)
      }
    }

    recognition.onend = () => {
      setListening(false)
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
      setListening(true)
    } catch (e) {
      console.error('启动语音识别失败:', e)
      setListening(false)
    }
  }, [onTranscript])

  // 停止语音识别
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // 忽略停止时的错误
      }
      recognitionRef.current = null
    }
    setListening(false)
  }, [])

  // 切换
  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening()
    } else {
      startListening()
    }
  }, [listening, startListening, stopListening])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch { /* ignore */ }
      }
    }
  }, [])

  // 浏览器不支持时隐藏
  if (!supported) return null

  return (
    <Tooltip title={listening ? '点击停止录音' : '点击开始语音输入'}>
      <Button
        icon={listening ? <StopOutlined /> : <AudioOutlined />}
        size="small"
        onClick={toggleListening}
        disabled={disabled}
        type={listening ? 'primary' : 'default'}
        danger={listening}
        style={listening ? {
          animation: 'voice-pulse 1.2s ease-in-out infinite',
        } : {}}
      />
    </Tooltip>
  )
}

export default VoiceInput
