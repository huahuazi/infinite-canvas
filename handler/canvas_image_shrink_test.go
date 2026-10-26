package handler

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

// noisyTestImage 生成高熵测试图，模拟手机照片的细节密度。
// 纯色图压缩率过高，测不出真实场景的体积。
func noisyTestImage(width, height int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	seed := uint32(12345)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			seed = seed*1664525 + 1013904223
			n := uint8(seed >> 24)
			img.Set(x, y, color.RGBA{R: uint8(x*255/width) ^ n, G: uint8(y*255/height) ^ (n >> 1), B: n, A: 255})
		}
	}
	return img
}

// 用户实测的那张参考图是 3840x5760 / 5.48MB，被 hub 的 /images/edits 拒成 file too large。
// 这里确认同量级的图能被压到 canvasTaskImageMaxBytes 以内。
func TestShrinkCanvasTaskImageBringsPhonePhotoUnderLimit(t *testing.T) {
	var original bytes.Buffer
	if err := jpeg.Encode(&original, noisyTestImage(3840, 5760), &jpeg.Options{Quality: 92}); err != nil {
		t.Fatalf("构造测试图失败: %v", err)
	}
	raw := original.Bytes()
	t.Logf("原图 %d 字节（%.2f MB），上限 %d 字节", len(raw), float64(len(raw))/(1<<20), canvasTaskImageMaxBytes)
	if len(raw) <= canvasTaskImageMaxBytes {
		t.Skipf("测试图只有 %.2f MB，未超过上限，跳过", float64(len(raw))/(1<<20))
	}

	shrunken, ok := shrinkCanvasTaskImage(raw, canvasTaskImageMaxBytes)
	if !ok {
		t.Fatalf("应压缩但未压缩（原图 %.2f MB）", float64(len(raw))/(1<<20))
	}
	if len(shrunken) > canvasTaskImageMaxBytes {
		t.Fatalf("压缩后仍有 %d 字节，超出上限 %d", len(shrunken), canvasTaskImageMaxBytes)
	}
	decoded, _, err := image.Decode(bytes.NewReader(shrunken))
	if err != nil {
		t.Fatalf("压缩结果无法解码: %v", err)
	}
	b := decoded.Bounds()
	t.Logf("压缩后 %d 字节（%.2f MB），尺寸 %dx%d", len(shrunken), float64(len(shrunken))/(1<<20), b.Dx(), b.Dy())
	if b.Dx() == 0 || b.Dy() == 0 {
		t.Fatal("压缩后尺寸无效")
	}
}

// 未超上限的图必须原样返回，不做无谓降质。
func TestShrinkCanvasTaskImageKeepsSmallImage(t *testing.T) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, noisyTestImage(320, 480), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("构造测试图失败: %v", err)
	}
	raw := buf.Bytes()
	out, ok := shrinkCanvasTaskImage(raw, canvasTaskImageMaxBytes)
	if ok {
		t.Fatal("小图不该被压缩")
	}
	if len(out) != len(raw) {
		t.Fatalf("小图应原样返回，长度 %d → %d", len(raw), len(out))
	}
}

// 无法解码的字节（如 webp）必须原样放行，交给上游报它自己的错。
func TestShrinkCanvasTaskImagePassesUndecodable(t *testing.T) {
	raw := []byte("not-an-image-but-over-limit")
	out, ok := shrinkCanvasTaskImage(raw, 8)
	if ok {
		t.Fatal("解不开的格式不该声称压缩成功")
	}
	if len(out) != len(raw) {
		t.Fatalf("应原样返回，长度 %d → %d", len(raw), len(out))
	}
}
