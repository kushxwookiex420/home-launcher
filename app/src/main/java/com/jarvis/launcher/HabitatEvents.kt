package com.jarvis.launcher

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Turns one Habitat payload into "what finished since the last successful sync".
 *
 * This is deliberately pure: it reads the same fields the panel shows and invents nothing. An item
 * becomes an event only when Habitat reports a terminal status, the item carries a real timestamp,
 * and that timestamp is newer than the previous successful sync. A queued phone command is never an
 * event; only the phone's own reported result is.
 */
object HabitatEvents {

    private val TERMINAL = setOf("done", "failed", "completed")
    private val ISO = arrayOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'"
    )

    class Event(val key: String, val title: String, val body: String)

    fun since(payload: JSONObject, sinceMs: Long): List<Event> {
        // The very first sync only records a baseline; history is not news.
        if (sinceMs <= 0L) return emptyList()
        val events = mutableListOf<Event>()

        payload.optJSONObject("ax")?.optJSONArray("tasks")?.let { tasks ->
            for (index in 0 until tasks.length()) {
                val task = tasks.optJSONObject(index) ?: continue
                val status = task.optString("status").lowercase(Locale.US)
                if (status !in TERMINAL) continue
                if (time(task.optString("at")) <= sinceMs) continue
                val id = task.optString("id")
                events += Event(
                    "ax:$id:$status",
                    "AX · " + status.uppercase(Locale.US),
                    body(task)
                )
            }
        }

        payload.optJSONObject("buff")?.optJSONArray("queue")?.let { queue ->
            for (index in 0 until queue.length()) {
                val task = queue.optJSONObject(index) ?: continue
                val status = task.optString("status").lowercase(Locale.US)
                if (status !in TERMINAL) continue
                if (time(task.optString("at")) <= sinceMs) continue
                val id = task.optString("id")
                events += Event(
                    "buff:$id:$status",
                    "BUFF · " + status.uppercase(Locale.US),
                    body(task)
                )
            }
        }

        payload.optJSONObject("phone")?.optJSONArray("commands")?.let { commands ->
            for (index in 0 until commands.length()) {
                val command = commands.optJSONObject(index) ?: continue
                val status = command.optString("status").lowercase(Locale.US)
                if (status !in TERMINAL) continue
                if (time(command.optString("at")) <= sinceMs) continue
                val id = command.optString("id")
                val action = command.optString("action")
                val output = command.optString("output")
                events += Event(
                    "phone:$id:$status",
                    "PHONE · " + action.uppercase(Locale.US) + " " + status.uppercase(Locale.US),
                    if (output.isBlank()) "The phone reported no output." else output
                )
            }
        }

        return events
    }

    private fun body(task: JSONObject): String {
        val title = task.optString("title")
        val text = task.optString("text")
        val label = if (title.isNotBlank()) title else text
        val artifacts = task.optJSONArray("artifacts")?.length() ?: 0
        return when {
            label.isBlank() -> "$artifacts artifact(s)"
            artifacts > 0 -> "$label · $artifacts artifact(s)"
            else -> label
        }
    }

    fun time(value: String): Long {
        if (value.isBlank()) return 0L
        for (pattern in ISO) {
            val parsed = runCatching {
                SimpleDateFormat(pattern, Locale.US)
                    .apply { timeZone = TimeZone.getTimeZone("UTC") }
                    .parse(value)?.time
            }.getOrNull()
            if (parsed != null && parsed > 0L) return parsed
        }
        return 0L
    }
}
