package handler

import (
	"strconv"
	"testing"
	"time"
)

// 占位号里带毫秒时间戳时，宽限期要按时间戳算——服务重启后内存记录会丢，
// 时间戳不会，这样重启前提交的请求仍能被正确判定。
func TestClientVideoTaskTimestampExtractsMillis(t *testing.T) {
	now := time.Now().UnixMilli()
	id := "client_video_task_video-" + strconv.FormatInt(now, 10) + "-aqpwg"
	ts, ok := clientVideoTaskTimestamp(id)
	if !ok {
		t.Fatalf("应能从 %s 里取到时间戳", id)
	}
	if ts != now {
		t.Fatalf("取到 %d，期望 %d", ts, now)
	}
}

// nanoid 形态没有时间戳，不能瞎猜。
func TestClientVideoTaskTimestampRejectsNanoid(t *testing.T) {
	if _, ok := clientVideoTaskTimestamp("client_video_task_V1StGXR8Z5jdHi6BmyT"); ok {
		t.Fatal("纯字母数字的 nanoid 不该解析出时间戳")
	}
	// 恰好 13 位数字但不在合理时间区间（这里对应 2011 年），必须拒绝
	if _, ok := clientVideoTaskTimestamp("client_video_task_1234567890123"); ok {
		t.Fatal("不在合理区间的时间戳应被拒绝")
	}
}

// 刚生成的占位号必须在宽限期内（否则正常提交会被误报成失败）。
func TestClientVideoTaskWithinGraceFresh(t *testing.T) {
	id := "client_video_task_video-" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "-fresh"
	if !clientVideoTaskWithinGrace(id) {
		t.Fatal("刚生成的占位号应在宽限期内")
	}
}

// 超过宽限期的占位号（提交压根没到后端）必须判为超期。
func TestClientVideoTaskWithinGraceExpired(t *testing.T) {
	stale := time.Now().Add(-5 * time.Minute).UnixMilli()
	id := "client_video_task_video-" + strconv.FormatInt(stale, 10) + "-stale"
	if clientVideoTaskWithinGrace(id) {
		t.Fatal("5 分钟前的占位号应判为超期")
	}
}

// 没有时间戳的占位号：首次查询算在宽限期内（给提交入库留时间）。
func TestClientVideoTaskWithinGraceFallbackFirstSeen(t *testing.T) {
	id := "client_video_task_NoTimestamp" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if !clientVideoTaskWithinGrace(id) {
		t.Fatal("首次查询应算作宽限期内")
	}
}
