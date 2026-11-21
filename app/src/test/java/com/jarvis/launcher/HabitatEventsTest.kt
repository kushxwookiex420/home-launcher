package com.jarvis.launcher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class HabitatEventsTest {

    private fun payload(): JSONObject = JSONObject(
        """
        {
          "ax": { "tasks": [
            { "id": "t1", "title": "ship it", "status": "done", "at": "2026-11-21T12:30:00.000Z",
              "artifacts": ["https://example.test/x.apk"] },
            { "id": "t2", "title": "still running", "status": "working", "at": "2026-11-21T12:31:00Z" }
          ] },
          "buff": { "queue": [
            { "id": "q1", "title": "old build", "status": "done", "at": "2026-11-20T09:00:00Z" }
          ] },
          "phone": { "commands": [
            { "id": "c1", "action": "status", "status": "done", "output": "BATT 92", "at": "2026-11-21T12:32:00Z" },
            { "id": "c2", "action": "torch", "status": "queued", "output": null, "at": "2026-11-21T12:33:00Z" }
          ] }
        }
        """.trimIndent()
    )

    @Test
    fun `only terminal items newer than the last sync become events`() {
        val since = HabitatEvents.time("2026-11-21T12:00:00Z")
        val events = HabitatEvents.since(payload(), since)
        val keys = events.map { it.key }
        assertTrue(keys.contains("ax:t1:done"))
        assertTrue(keys.contains("phone:c1:done"))
        // working is not a result, queued is not an execution, and the old build predates the sync
        assertEquals(false, keys.contains("ax:t2:working"))
        assertEquals(false, keys.contains("phone:c2:queued"))
        assertEquals(false, keys.contains("buff:q1:done"))
    }

    @Test
    fun `the first sync records a baseline instead of replaying history`() {
        assertEquals(0, HabitatEvents.since(payload(), 0L).size)
    }

    @Test
    fun `a phone result carries the phone's own output`() {
        val since = HabitatEvents.time("2026-11-21T12:00:00Z")
        val event = HabitatEvents.since(payload(), since).first { it.key.startsWith("phone:") }
        assertEquals("PHONE · STATUS DONE", event.title)
        assertEquals("BATT 92", event.body)
    }

    @Test
    fun `an artifact task names its count`() {
        val since = HabitatEvents.time("2026-11-21T12:00:00Z")
        val event = HabitatEvents.since(payload(), since).first { it.key.startsWith("ax:") }
        assertEquals("ship it · 1 artifact(s)", event.body)
    }

    @Test
    fun `unparseable timestamps never become events`() {
        val broken = JSONObject(
            """{ "ax": { "tasks": [ { "id": "x", "status": "done", "at": "not-a-date" } ] } }"""
        )
        assertEquals(0, HabitatEvents.since(broken, HabitatEvents.time("2026-11-21T12:00:00Z")).size)
        assertEquals(0L, HabitatEvents.time("not-a-date"))
    }
}
