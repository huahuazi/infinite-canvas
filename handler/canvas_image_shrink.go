package handler

import (
	"bytes"
	"errors"
	"image"
	stddraw "image/draw"
	"image/jpeg"

	xdraw "golang.org/x/image/draw"
)

var errEmptyCanvasTaskImage = errors.New("图片尺寸无效")

// canvasTaskImageMaxBytes 是生图参考图的体积上限。
// 上游（OpenAI 兼容的 /images/edits）通常限单张 4MB，这里留出 multipart 编码余量。
const canvasTaskImageMaxBytes = 3 << 20

// canvasTaskImageShrinkSteps 逐档收敛：先保分辨率降质量，再逐步缩尺寸。
// 与前端 web/src/lib/image-compress.ts 的策略保持一致，避免两边压出不同结果。
var canvasTaskImageShrinkSteps = []struct {
	maxSide int
	quality int
}{
	{2560, 92},
	{2048, 88},
	{1792, 85},
	{1536, 82},
	{1280, 80},
	{1024, 75},
}

// shrinkCanvasTaskImage 把超过上限的参考图压到可发送体积，返回新字节与是否压缩过。
//
// 前端也会压（image-compress.ts），但那依赖浏览器已加载最新脚本——页面开着旧 chunk
// 时压缩根本不会执行，请求照样是原图。后端兜底保证任何客户端都能出图。
// 解不开的格式（如 webp）原样返回，交给上游给出它自己的错误，不在这里假装成功。
func shrinkCanvasTaskImage(data []byte, maxBytes int) ([]byte, bool) {
	if maxBytes <= 0 || len(data) <= maxBytes {
		return data, false
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data, false
	}
	for _, step := range canvasTaskImageShrinkSteps {
		shrunken, err := encodeCanvasTaskJPEG(source, step.maxSide, step.quality)
		if err != nil {
			continue
		}
		if len(shrunken) <= maxBytes {
			return shrunken, true
		}
	}
	return data, false
}

// encodeCanvasTaskJPEG 按最长边缩放后编码为 JPEG。
// JPEG 没有透明通道，缩放前铺白底，否则 PNG 的透明区域会变成黑底污染生成结果。
func encodeCanvasTaskJPEG(source image.Image, maxSide, quality int) ([]byte, error) {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, errEmptyCanvasTaskImage
	}
	targetWidth, targetHeight := width, height
	if longest := maxInt(width, height); longest > maxSide && maxSide > 0 {
		scale := float64(maxSide) / float64(longest)
		targetWidth = maxInt(1, int(float64(width)*scale))
		targetHeight = maxInt(1, int(float64(height)*scale))
	}
	canvas := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	stddraw.Draw(canvas, canvas.Bounds(), image.White, image.Point{}, stddraw.Src)
	if targetWidth == width && targetHeight == height {
		stddraw.Draw(canvas, canvas.Bounds(), source, bounds.Min, stddraw.Over)
	} else {
		xdraw.CatmullRom.Scale(canvas, canvas.Bounds(), source, bounds, xdraw.Over, nil)
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, canvas, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
