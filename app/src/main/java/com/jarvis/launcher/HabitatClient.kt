package com.jarvis.launcher

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/**
 * The phone's side of the Habitat control center.
 *
 * The device never holds the relay's ax or buff credential. It asks Habitat, which holds those
 * server-side, and authenticates with its own per-device token obtained from POST /device/pair.
 * Every call is a plain GET/POST; nothing here logs, stores in plain text outside private
 * preferences, or hands the token to a WebView.
 */
object HabitatClient {

    const val DEFAULT_BASE = "https://habitat-1-szzd.onrender.com"

    private const val PREFS = "launcher_state"
    private const val KEY_BASE = "habitat_base"
    private const val KEY_DEVICE_ID = "habitat_device_id"
    private const val KEY_TOKEN = "habitat_device_token"
    private const val KEY_SYNC = "habitat_last_sync"

    /** A failure with a message fit to show on screen; never contains the token. */
    class Failure(message: String) : Exception(message)

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun base(context: Context): String {
        val stored = prefs(context).getString(KEY_BASE, "").orEmpty().trim()
        return if (stored.startsWith("http")) stored.trimEnd('/') else DEFAULT_BASE
    }

    fun setBase(context: Context, value: String) {
        val trimmed = value.trim().trimEnd('/')
        prefs(context).edit().putString(KEY_BASE, if (trimmed.startsWith("http")) trimmed else DEFAULT_BASE).apply()
    }

    /** Stable id for this phone; generated once and kept, so pairing survives restarts. */
    fun deviceId(context: Context): String {
        val existing = prefs(context).getString(KEY_DEVICE_ID, "").orEmpty()
        if (existing.isNotBlank()) return existing
        val created = "launcher-" + UUID.randomUUID().toString()
        prefs(context).edit().putString(KEY_DEVICE_ID, created).apply()
        return created
    }

    fun token(context: Context): String = prefs(context).getString(KEY_TOKEN, "").orEmpty()

    fun isLinked(context: Context): Boolean = token(context).isNotBlank()

    fun lastSync(context: Context): Long = prefs(context).getLong(KEY_SYNC, 0L)

    fun unlink(context: Context) {
        prefs(context).edit().remove(KEY_TOKEN).remove(KEY_SYNC).apply()
    }

    /**
     * Exchanges a pairing code (created in Habitat for this device id) for a device token.
     * The code is single use and short lived; the token that comes back is what gets stored.
     */
    fun link(context: Context, code: String): JSONObject {
        val deviceId = deviceId(context)
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("code", code.trim())
        }.toString()
        val reply = request(context, "POST", "/device/pair", payload, token = null)
        val issued = reply.optString("token").ifBlank {
            reply.optString("deviceToken").ifBlank {
                reply.optJSONObject("device")?.optString("token").orEmpty()
            }
        }
        if (issued.isBlank()) throw Failure("Habitat did not return a device token.")

        // Do not persist or report a linked state until this exact device token has
        // successfully authenticated against the protected dashboard endpoint.
        val heartbeatPath = "/device/habitat?deviceId=" +
            URLEncoder.encode(deviceId, "UTF-8")
        request(context, "GET", heartbeatPath, null, issued)

        prefs(context).edit()
            .putString(KEY_TOKEN, issued)
            .putLong(KEY_SYNC, System.currentTimeMillis())
            .apply()
        return reply
    }

    /** One aggregated dashboard payload. Throws [Failure] with a displayable message. */
    fun dashboard(context: Context): JSONObject {
        val deviceId = deviceId(context)
        val reply = request(
            context,
            "GET",
            "/device/habitat?deviceId=" + URLEncoder.encode(deviceId, "UTF-8"),
            null,
            token(context)
        )
        prefs(context).edit().putLong(KEY_SYNC, System.currentTimeMillis()).apply()
        return reply
    }

    /** Queue an allowlisted phone action through Habitat (never with a relay credential here). */
    fun sendPhoneAction(context: Context, action: String, arg: String = ""): JSONObject {
        val payload = JSONObject().apply {
            put("deviceId", deviceId(context))
            put("action", action)
            put("arg", arg)
        }.toString()
        return request(context, "POST", "/device/habitat/phone", payload, token(context))
    }

    /** Read one shared project file. Text only; binary files come back base64. */
    fun readFile(context: Context, name: String): JSONObject {
        val deviceId = deviceId(context)
        val path = "/device/habitat/file?deviceId=" + URLEncoder.encode(deviceId, "UTF-8") +
            "&name=" + URLEncoder.encode(name, "UTF-8")
        return request(context, "GET", path, null, token(context))
    }

    private fun request(
        context: Context,
        method: String,
        path: String,
        body: String?,
        token: String?
    ): JSONObject {
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(base(context) + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10000
                readTimeout = 20000
                setRequestProperty("Accept", "application/json")
                if (token != null) setRequestProperty("Authorization", "Bearer " + token)
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) connection.outputStream.use { it.write(body.toByteArray()) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (status !in 200..299) {
                val detail = json?.optString("error").orEmpty()
                throw Failure(
                    when {
                        detail.isNotBlank() -> detail
                        status == 401 -> "This phone is not linked to Habitat."
                        status == 503 -> "Habitat has no device store configured."
                        else -> "Habitat answered HTTP $status."
                    }
                )
            }
            return json ?: throw Failure("Habitat sent a response that was not JSON.")
        } catch (failure: Failure) {
            throw failure
        } catch (error: Exception) {
            throw Failure(
                when (error) {
                    is java.net.SocketTimeoutException -> "Habitat timed out."
                    is java.net.UnknownHostException -> "Habitat host is unreachable."
                    else -> "Habitat unreachable: " + (error.message ?: error::class.java.simpleName)
                }
            )
        } finally {
            runCatching { connection?.disconnect() }
        }
    }
}
