/**
 * 摄像头拍照组件
 * 调用设备摄像头拍照，生成 File 对象供对话上传
 */
import React, { useRef, useState, useEffect, useCallback } from 'react'
import { Modal, Button, Space, Typography, message } from 'antd'
import { CameraOutlined, ReloadOutlined, CheckOutlined, PictureOutlined } from '@ant-design/icons'

interface CameraCaptureProps {
  open: boolean
  onClose: () => void
  onCapture: (file: File) => void
}

const CameraCapture: React.FC<CameraCaptureProps> = ({ open, onClose, onCapture }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fallbackInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const startingRef = useRef(false)       // 防止并发启动
  const mountedRef = useRef(false)        // 跟踪组件是否已卸载
  const [capturedImage, setCapturedImage] = useState<string | null>(null)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)
  const [error, setError] = useState<string>('')
  const [cameraStarted, setCameraStarted] = useState(false)
  const [mediaDevicesSupported, setMediaDevicesSupported] = useState(true)

  // 带超时的 getUserMedia（修复竞态：超时后如果流才到，立即释放）
  const getUserMediaWithTimeout = useCallback(
    (constraints: MediaStreamConstraints, timeoutMs = 10000): Promise<MediaStream> => {
      let timedOut = false

      return new Promise<MediaStream>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true
          reject(new DOMException('摄像头启动超时', 'TimeoutError'))
        }, timeoutMs)

        navigator.mediaDevices.getUserMedia(constraints).then(
          (stream) => {
            clearTimeout(timer)
            if (timedOut) {
              // 超时之后才拿到流 → 释放掉，避免摄像头指示灯一直亮着
              stream.getTracks().forEach(t => t.stop())
              reject(new DOMException('摄像头启动超时', 'TimeoutError'))
            } else {
              resolve(stream)
            }
          },
          (err) => {
            clearTimeout(timer)
            reject(err)
          }
        )
      })
    },
    []
  )

  // 枚举可用摄像头
  const enumerateCameras = useCallback(async (): Promise<string[]> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter(d => d.kind === 'videoinput').map(d => d.label || d.deviceId)
    } catch {
      return []
    }
  }, [])

  // 启动摄像头
  const startCamera = useCallback(async () => {
    // 防止并发
    if (startingRef.current) {
      console.warn('摄像头正在启动中，忽略重复请求')
      return
    }
    startingRef.current = true

    setError('')
    setCapturedImage(null)
    setCapturedFile(null)

    try {
      // 检查浏览器是否支持
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMediaDevicesSupported(false)
        setCameraStarted(false)
        return
      }
      setMediaDevicesSupported(true)

      // 枚举摄像头（仅调试用）
      const cams = await enumerateCameras()
      console.log(`检测到 ${cams.length} 个摄像头:`, cams)

      // 使用最简单的约束，不指定 facingMode/分辨率，最高兼容性
      // 大部分 timeout 是因为 facingMode 约束导致 Chrome 耗时过长
      const constraints: MediaStreamConstraints = {
        video: true,
        audio: false,
      }

      const mediaStream = await getUserMediaWithTimeout(constraints)

      // 组件已卸载，立即释放
      if (!mountedRef.current) {
        mediaStream.getTracks().forEach(t => t.stop())
        return
      }

      // ★ 先把流存起来，再标记 cameraStarted，触发视频元素渲染
      streamRef.current = mediaStream

      // 必须先设 cameraStarted=true 让 React 渲染出 <video> 元素，
      // 否则 videoRef.current 一直为 null，srcObject 设置不上去 → 黑屏
      setCameraStarted(true)

      // 等 React 提交更新，<video> 元素挂载到 DOM
      await new Promise(resolve => setTimeout(resolve, 50))

      if (!mountedRef.current) return

      const videoEl = videoRef.current
      if (videoEl) {
        videoEl.srcObject = mediaStream
        try {
          await videoEl.play()
        } catch (playErr) {
          console.warn('视频 play() 失败:', playErr)
        }
      } else {
        console.warn('视频元素未挂载，重试中...')
        // 再给一次机会
        await new Promise(resolve => setTimeout(resolve, 100))
        const retryEl = videoRef.current
        if (retryEl && mountedRef.current) {
          retryEl.srcObject = mediaStream
          try { await retryEl.play() } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return

      const e = err as { name?: string; message?: string }
      console.error('摄像头启动失败:', e)

      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        setError('摄像头权限被拒绝，请在浏览器设置中允许摄像头访问')
      } else if (e.name === 'NotFoundError') {
        setError('未检测到摄像头设备')
      } else if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        // 硬件级别超时，不重试了（重试也会一样）
        // 提供明确的解决方法并显示文件上传兜底
        setError(
          '无法启动摄像头（超时）。\n' +
          '请尝试：\n' +
          '1. 关闭其他使用摄像头的应用（Zoom/Teams/微信等）\n' +
          '2. 检查摄像头驱动是否正常\n' +
          '3. 也可以直接选择图片文件代替拍照'
        )
      } else if (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError') {
        setError('摄像头不兼容，请检查设备连接')
      } else if (e.name === 'NotReadableError') {
        setError('摄像头被其他应用占用，请关闭其他使用摄像头的程序后重试')
      } else {
        setError(e.message || '摄像头启动失败，请检查设备连接')
      }
      setCameraStarted(false)
    } finally {
      startingRef.current = false
    }
  }, [getUserMediaWithTimeout, enumerateCameras])

  // 停止摄像头
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop()
        track.enabled = false  // 确保完全释放
      })
      streamRef.current = null
    }
    setCameraStarted(false)
  }, [])

  // 拍照
  const capturePhoto = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    const width = video.videoWidth
    const height = video.videoHeight
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.translate(width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, width, height)

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          message.error('拍照失败，请重试')
          return
        }
        const timestamp = Date.now()
        const file = new File([blob], `camera_${timestamp}.jpg`, { type: 'image/jpeg' })
        setCapturedFile(file)
        setCapturedImage(canvas.toDataURL('image/jpeg', 0.9))
      },
      'image/jpeg',
      0.9
    )
  }, [])

  // 关闭
  const handleClose = useCallback(() => {
    stopCamera()
    setCapturedImage(null)
    setCapturedFile(null)
    setError('')
    setMediaDevicesSupported(true)
    onClose()
  }, [stopCamera, onClose])

  // 确认使用照片
  const confirmCapture = useCallback(() => {
    if (capturedFile) {
      onCapture(capturedFile)
      handleClose()
    }
  }, [capturedFile, onCapture, handleClose])

  // 重新拍照
  const retakePhoto = useCallback(() => {
    setCapturedImage(null)
    setCapturedFile(null)
  }, [])

  // 选择图片文件（回退方案）
  const handleFallbackFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setCapturedImage(url)
    setCapturedFile(file)
    e.target.value = ''
  }, [])

  // 打开/关闭时管理摄像头生命周期
  useEffect(() => {
    mountedRef.current = true
    let timer: ReturnType<typeof setTimeout> | null = null

    if (open) {
      timer = setTimeout(() => startCamera(), 300)
    }
    // 注意：Modal 有 destroyOnClose，关闭时会卸载组件，不需要在 else 里重置 state

    return () => {
      mountedRef.current = false
      if (timer) clearTimeout(timer)
      stopCamera()
    }
  // startCamera / stopCamera 均为空依赖 useCallback，稳定不变，加入 deps 不会导致循环
  }, [open, startCamera, stopCamera])

  return (
    <Modal
      title={<span><CameraOutlined style={{ marginRight: 8 }} />拍照输入</span>}
      open={open}
      onCancel={handleClose}
      footer={null}
      width={640}
      destroyOnHidden
      centered
    >
      <div style={{ textAlign: 'center' }}>
        {/* 摄像头预览 / 拍照结果 */}
        <div style={{
          position: 'relative',
          width: '100%',
          maxHeight: 400,
          minHeight: capturedImage ? 'auto' : 200,
          overflow: 'hidden',
          borderRadius: 8,
          background: '#111',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          {capturedImage ? (
            <img
              src={capturedImage}
              alt="已拍照"
              style={{
                width: '100%',
                maxHeight: 400,
                display: 'block',
                objectFit: 'contain',
              }}
            />
          ) : cameraStarted ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                maxHeight: 400,
                display: 'block',
                transform: 'scaleX(-1)',
              }}
            />
          ) : (
            <CameraOutlined style={{ fontSize: 48, color: '#444' }} />
          )}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>

        {/* 错误提示 + 兜底方案 */}
        <input
          ref={fallbackInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFallbackFile}
          style={{ display: 'none' }}
        />

        {error && (
          <div style={{ marginBottom: 16 }}>
            <Typography.Text type="danger" style={{ display: 'block', marginBottom: 8, whiteSpace: 'pre-line' }}>
              {error}
            </Typography.Text>
            <Space>
              <Button size="small" onClick={() => startCamera()}>
                重试摄像头
              </Button>
              <Button
                type="primary"
                size="small"
                icon={<PictureOutlined />}
                onClick={() => fallbackInputRef.current?.click()}
              >
                选择图片文件
              </Button>
            </Space>
          </div>
        )}

        {!mediaDevicesSupported && !capturedImage && !error && (
          <div style={{ marginBottom: 16 }}>
            <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8, whiteSpace: 'pre-line' }}>
              当前页面未通过 HTTPS 访问，浏览器限制了摄像头 API。
              您可以选择图片文件来代替拍照：
            </Typography.Text>
            <Button
              type="primary"
              icon={<PictureOutlined />}
              onClick={() => fallbackInputRef.current?.click()}
              size="large"
            >
              选择图片文件
            </Button>
          </div>
        )}

        {/* 操作按钮 */}
        <Space size={12}>
          {!capturedImage ? (
            cameraStarted && (
              <Button
                type="primary"
                icon={<CameraOutlined />}
                onClick={capturePhoto}
                size="large"
                style={{ borderRadius: 30, padding: '0 32px' }}
              >
                拍照
              </Button>
            )
          ) : (
            <>
              <Button
                icon={<ReloadOutlined />}
                onClick={retakePhoto}
                size="large"
              >
                重拍
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={confirmCapture}
                size="large"
                style={{ borderRadius: 30, padding: '0 32px' }}
              >
                使用照片
              </Button>
            </>
          )}
        </Space>

        {!cameraStarted && !error && mediaDevicesSupported && !capturedImage && (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 16 }}>
            正在启动摄像头...
          </Typography.Text>
        )}
      </div>
    </Modal>
  )
}

export default CameraCapture
