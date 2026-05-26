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
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [capturedImage, setCapturedImage] = useState<string | null>(null)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)
  const [error, setError] = useState<string>('')
  const [cameraStarted, setCameraStarted] = useState(false)
  const [mediaDevicesSupported, setMediaDevicesSupported] = useState(true)

  // 启动摄像头
  const startCamera = useCallback(async () => {
    setError('')
    setCapturedImage(null)
    setCapturedFile(null)

    // 检查浏览器是否支持 getUserMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMediaDevicesSupported(false)
      setCameraStarted(false)
      return
    }
    setMediaDevicesSupported(true)

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'environment',
        },
        audio: false,
      })
      setStream(mediaStream)
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
      }
      setCameraStarted(true)
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string }
      console.error('摄像头启动失败:', e)
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        setError('摄像头权限被拒绝，请在浏览器设置中允许摄像头访问')
      } else if (e.name === 'NotFoundError') {
        setError('未检测到摄像头设备')
      } else {
        setError(e.message || '摄像头启动失败，请检查设备连接')
      }
      setCameraStarted(false)
    }
  }, [])

  // 停止摄像头
  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
      setStream(null)
    }
    setCameraStarted(false)
  }, [stream])

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

    // 水平翻转（镜像效果）
    ctx.translate(width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, width, height)

    // 转换为 Blob
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

  // 确认使用照片
  const confirmCapture = useCallback(() => {
    if (capturedFile) {
      onCapture(capturedFile)
      handleClose()
    }
  }, [capturedFile, onCapture])

  // 重新拍照
  const retakePhoto = useCallback(() => {
    setCapturedImage(null)
    setCapturedFile(null)
  }, [])

  // 选择图片文件（回退方案）
  const handleFallbackFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // 显示预览
    const url = URL.createObjectURL(file)
    setCapturedImage(url)
    setCapturedFile(file)
    e.target.value = ''
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

  // 打开时自动启动摄像头
  useEffect(() => {
    if (open) {
      // 延迟启动，确保 Modal 动画完成视频元素已挂载
      setTimeout(() => startCamera(), 300)
    } else {
      stopCamera()
      setCapturedImage(null)
      setCapturedFile(null)
      setError('')
    }
    return () => {
      stopCamera()
    }
  }, [open, startCamera, stopCamera])

  return (
    <Modal
      title={<span><CameraOutlined style={{ marginRight: 8 }} />拍照输入</span>}
      open={open}
      onCancel={handleClose}
      footer={null}
      width={640}
      destroyOnClose
      centered
    >
      <div style={{ textAlign: 'center' }}>
        {/* 摄像头预览 / 拍照结果 */}
        <div style={{
          position: 'relative',
          width: '100%',
          maxHeight: 400,
          overflow: 'hidden',
          borderRadius: 8,
          background: '#000',
          marginBottom: 16,
        }}>
          {!capturedImage ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                maxHeight: 400,
                display: 'block',
                transform: 'scaleX(-1)', // 镜像显示，更自然
              }}
            />
          ) : (
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
          )}
          {/* 隐藏的 canvas 用于截图 */}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>

        {/* 错误提示 */}
        {error && (
          <Typography.Text type="danger" style={{ display: 'block', marginBottom: 16, whiteSpace: 'pre-line' }}>
            {error}
            <Button type="link" size="small" onClick={startCamera} style={{ marginLeft: 8 }}>
              重试
            </Button>
          </Typography.Text>
        )}

        {/* 环境不支持时的回退方案 */}
        {!mediaDevicesSupported && !capturedImage && (
          <>
            <Typography.Text type="warning" style={{ display: 'block', marginBottom: 16, whiteSpace: 'pre-line' }}>
              当前页面未通过 HTTPS 访问，浏览器限制了摄像头 API。
              您可以选择图片文件来代替拍照：
            </Typography.Text>
            <input
              ref={fallbackInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFallbackFile}
              style={{ display: 'none' }}
            />
            <Button
              type="primary"
              icon={<PictureOutlined />}
              onClick={() => fallbackInputRef.current?.click()}
              size="large"
            >
              选择图片文件
            </Button>
          </>
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
