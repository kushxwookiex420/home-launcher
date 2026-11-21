package com.jarvis.launcher

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.jarvis.launcher.databinding.PageHabitatBinding
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The Habitat control center, embedded in the launcher's home page.
 *
 * It is a plain View so it needs no wiring in MainActivity: it inflates itself, reads its own
 * state from preferences, and polls only while it is attached, visible and expanded. Collapsed it
 * costs nothing; expanded it refreshes every 90 seconds instead of streaming, to keep the phone
 * cool.
 *
 * Everything shown here comes from Habitat's /device/habitat payload, which is built from the
 * relay's real answers. Nothing is estimated: when a source is unavailable the panel says so.
 */
class HabitatDashboardView @JvmOverloads constructor(
    context: Context,
    attrs: android.util.AttributeSet? = null,
    defStyleAttr: Int = 0
) : LinearLayout(context, attrs, defStyleAttr) {

    private enum class Section(val label: String) {
        AX("AX"),
        BUFF("BUFF"),
        PHONE("PHONE"),
        WORKERS("WORKERS"),
        BUSINESS("BUSINESS"),
        FILES("FILES"),
        CLOUD("CLOUD")
    }

    private val binding = PageHabitatBinding.inflate(LayoutInflater.from(context), this, true)
    private val handler = Handler(Looper.getMainLooper())
    private val prefs = context.getSharedPreferences("launcher_state", Context.MODE_PRIVATE)
    private val stamp = SimpleDateFormat("HH:mm:ss", Locale.US)

    private var section = Section.AX
    private var payload: JSONObject? = null
    private var lastRefreshFailed = false
    private var expanded: Boolean
        get() = prefs.getBoolean("habitat_expanded", false)
        set(value) {
            prefs.edit().putBoolean("habitat_expanded", value).apply()
            applyExpanded()
        }

    private var ticking = false
    private val ticker: Runnable = object : Runnable {
        override fun run() {
            ticking = false
            if (polling()) {
                refresh()
                handler.postDelayed(this, REFRESH_MS)
            }
        }
    }

    init {
        orientation = VERTICAL
        binding.habitatHeader.setOnClickListener { expanded = !expanded }
        binding.habitatHeader.setOnLongClickListener {
            copyDeviceId()
            true
        }
        binding.habitatRefresh.setOnClickListener { refresh() }
        binding.habitatUnlink.setOnClickListener {
            HabitatClient.unlink(context)
            payload = null
            renderIdle()
            flash(str(R.string.habitat_unlinked), soft = false)
        }
        binding.habitatLink.setOnClickListener { link() }
        buildTabs()
        applyExpanded()
        renderIdle()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        syncTicker()
    }

    override fun onDetachedFromWindow() {
        handler.removeCallbacksAndMessages(null)
        super.onDetachedFromWindow()
    }

    // ---- chrome ------------------------------------------------------------

    /**
     * Polling needs three real conditions, not a timer alone: expanded, attached and actually
     * visible. Collapsed, backgrounded, or parked on another ViewPager page, it schedules nothing.
     */
    private fun polling(): Boolean = expanded && isAttachedToWindow && isShown

    private fun syncTicker(refreshIfStale: Boolean = true) {
        handler.removeCallbacks(ticker)
        if (!polling()) return
        if (refreshIfStale) {
            val last = HabitatClient.lastSync(context)
            if (last <= 0L || System.currentTimeMillis() - last >= REFRESH_MS) refresh()
        }
        handler.postDelayed(ticker, REFRESH_MS)
    }

    private fun applyExpanded() {
        binding.habitatBody.visibility = if (expanded) View.VISIBLE else View.GONE
        binding.habitatToggle.setText(if (expanded) R.string.habitat_close else R.string.habitat_open)
        binding.habitatLinkRow.visibility =
            if (!HabitatClient.isLinked(context) && expanded) View.VISIBLE else View.GONE
        syncTicker()
        if (expanded) HabitatNotifier.ensurePermission(context)
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (isVisible) syncTicker() else handler.removeCallbacks(ticker)
    }

    private fun buildTabs() {
        binding.habitatTabs.removeAllViews()
        Section.values().forEach { entry ->
            val tab = TextView(context).apply {
                text = entry.label
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 8f)
                typeface = Typeface.MONOSPACE
                letterSpacing = 0.14f
                setPadding(dp(9), dp(5), dp(9), dp(5))
                setTextColor(color(R.color.text_dim))
                background = ContextCompat.getDrawable(context, R.drawable.bg_habitat_chip)
                setOnClickListener {
                    section = entry
                    paintTabs()
                    renderSection()
                }
            }
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.marginEnd = dp(4)
            binding.habitatTabs.addView(tab, params)
        }
        paintTabs()
    }

    private fun paintTabs() {
        (0 until binding.habitatTabs.childCount).forEach { index ->
            val tab = binding.habitatTabs.getChildAt(index) as TextView
            val active = Section.values()[index] == section
            tab.setTextColor(color(if (active) R.color.cyan else R.color.text_dim))
            tab.alpha = if (active) 1f else 0.8f
        }
    }

    private fun copyDeviceId() {
        val id = HabitatClient.deviceId(context)
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("habitat device id", id))
        Toast.makeText(context, str(R.string.habitat_id_copied), Toast.LENGTH_SHORT).show()
    }

    private fun link() {
        val code = binding.habitatCode.text.toString().trim()
        if (code.isEmpty()) {
            flash(str(R.string.habitat_code_empty), soft = true)
            return
        }
        flash(str(R.string.habitat_linking), soft = true)
        Thread {
            val outcome = runCatching { HabitatClient.link(context, code) }
            handler.post {
                outcome.onSuccess {
                    binding.habitatCode.setText("")
                    binding.habitatLinkRow.visibility = View.GONE
                    flash(str(R.string.habitat_linked), soft = true)
                    refresh()
                }.onFailure { flash(it.message ?: str(R.string.habitat_link_failed), soft = true) }
            }
        }.start()
    }

    // ---- data --------------------------------------------------------------

    fun refresh() {
        if (ticking) return
        ticking = true
        binding.habitatSync.text = str(R.string.habitat_syncing)
        Thread {
            val outcome = runCatching { HabitatClient.dashboard(context) }
            handler.post {
                ticking = false
                outcome.onSuccess {
                    payload = it
                    lastRefreshFailed = false
                    binding.habitatError.visibility = View.GONE
                    paintChrome()
                    renderSection()
                    HabitatNotifier.onSync(context, it)
                }.onFailure {
                    // Keep the last successful payload visible; paintChrome marks it stale/offline.
                    lastRefreshFailed = true
                    paintChrome()
                    renderSection()
                    flash(it.message ?: str(R.string.habitat_unreachable), soft = false)
                }
            }
        }.start()
    }

    // ---- painting ----------------------------------------------------------

    private fun paintChrome() {
        val data = payload
        val linked = HabitatClient.isLinked(context)
        val health = data?.optJSONObject("relay")?.optString("health").orEmpty()
        val online = !lastRefreshFailed && health == "ok"
        binding.habitatChip.setText(
            when {
                !linked -> R.string.habitat_offline_chip
                online -> R.string.habitat_online_chip
                data != null -> R.string.habitat_degraded_chip
                else -> R.string.habitat_offline_chip
            }
        )
        binding.habitatChip.setTextColor(color(if (online) R.color.cyan else R.color.text_dim))
        val last = HabitatClient.lastSync(context)
        // A failed refresh still reports when the data was last accurate, rather than claiming it
        // never synced. Nothing is shown as current unless the last call succeeded.
        val syncLine = when {
            !linked -> str(R.string.habitat_not_linked) + " · ID " + shortId()
            lastRefreshFailed && last > 0 -> str(R.string.habitat_last_sync_failed, stamp.format(Date(last)))
            data != null && last > 0 -> str(R.string.habitat_synced) + " " + stamp.format(Date(last))
            data == null && last > 0 -> str(R.string.habitat_last_sync_failed, stamp.format(Date(last)))
            else -> str(R.string.habitat_not_synced)
        }
        binding.habitatSync.text = syncLine
        binding.habitatLinkRow.visibility =
            if (!linked && expanded) View.VISIBLE else View.GONE
    }

    private fun renderIdle() {
        binding.habitatChip.setText(R.string.habitat_offline_chip)
        binding.habitatChip.setTextColor(color(R.color.text_dim))
        binding.habitatSync.text =
            str(if (HabitatClient.isLinked(context)) R.string.habitat_not_synced else R.string.habitat_not_linked) +
                " · ID " + shortId()
        paintChrome()
    }

    private fun renderSection() {
        val box = binding.habitatContent
        box.removeAllViews()
        binding.habitatActions.removeAllViews()
        binding.habitatActions.visibility = View.GONE
        val data = payload
        if (data == null) {
            box.addView(line(str(if (HabitatClient.isLinked(context)) R.string.habitat_pull_refresh else R.string.habitat_link_first)))
            return
        }
        when (section) {
            Section.AX -> renderAx(data, box)
            Section.BUFF -> renderBuff(data, box)
            Section.PHONE -> renderPhone(data, box)
            Section.WORKERS -> renderWorkers(data, box)
            Section.BUSINESS -> renderBusiness(data, box)
            Section.FILES -> renderFiles(data, box)
            Section.CLOUD -> renderCloud(data, box)
        }
        data.optJSONArray("errors")?.let { errors ->
            if (errors.length() > 0) {
                val first = errors.optJSONObject(0)
                flash(
                    str(R.string.habitat_partial) + " " +
                        (first?.optString("source").orEmpty()) + ": " + (first?.optString("error").orEmpty()),
                    soft = false
                )
            }
        }
    }

    private fun renderAx(data: JSONObject, box: LinearLayout) {
        val ax = data.optJSONObject("ax") ?: return
        val counts = ax.optJSONObject("counts")
        box.addView(
            line(
                "QUEUED " + counts?.optInt("queued", 0) + "   WORKING " + counts?.optInt("working", 0) +
                    "   DONE " + counts?.optInt("done", 0)
            )
        )
        val tasks = ax.optJSONArray("tasks")
        if (tasks == null || tasks.length() == 0) {
            box.addView(line(str(R.string.habitat_no_tasks)))
            return
        }
        for (index in 0 until minOf(tasks.length(), 3)) {
            val task = tasks.optJSONObject(index) ?: continue
            val title = task.optString("title").ifBlank { task.optString("text") }
            box.addView(
                line(
                    "▸ " + task.optString("status").uppercase(Locale.US) + " · " + trim(title, 58),
                    statusColor(task.optString("status"))
                )
            )
        }
        val done = (0 until minOf(tasks.length(), 3))
            .mapNotNull { tasks.optJSONObject(it) }
            .sumOf { it.optJSONArray("artifacts")?.length() ?: 0 }
        if (done > 0) box.addView(line("$done ARTIFACT LINK(S) · REVIEW IN TASKS", color(R.color.violet)))
    }

    private fun renderBuff(data: JSONObject, box: LinearLayout) {
        val buff = data.optJSONObject("buff") ?: return
        val queue = buff.optJSONArray("queue")
        box.addView(line(str(R.string.habitat_buff_queue, queue?.length() ?: 0)))
        if (queue != null) {
            for (index in 0 until minOf(queue.length(), 3)) {
                val task = queue.optJSONObject(index) ?: continue
                val title = task.optString("title").ifBlank { task.optString("text") }
                box.addView(line("▸ " + trim(title, 58), statusColor(task.optString("status"))))
            }
        }
        val replies = buff.optJSONArray("replies")
        if (replies != null && replies.length() > 0) {
            box.addView(line(str(R.string.habitat_latest_reply), color(R.color.violet)))
            val reply = replies.optJSONObject(replies.length() - 1)
            box.addView(line("· " + trim(reply?.optString("text").orEmpty(), 90)))
            val artifacts = reply?.optJSONArray("artifacts")
            if (artifacts != null && artifacts.length() > 0) {
                box.addView(
                    line("· " + artifacts.length() + " artifact(s): " + trim(artifacts.optString(0), 46), color(R.color.cyan))
                )
            }
        } else {
            box.addView(line(str(R.string.habitat_no_replies)))
        }
    }

    private fun renderPhone(data: JSONObject, box: LinearLayout) {
        val phone = data.optJSONObject("phone") ?: return
        val online = phone.optBoolean("online", false)
        box.addView(
            line(
                (phone.optString("name").ifBlank { "phone" }) + " · " +
                    str(if (online) R.string.habitat_phone_online else R.string.habitat_phone_offline),
                if (online) color(R.color.cyan) else color(R.color.text_dim)
            )
        )
        val lastSeen = phone.optLong("lastSeen", 0L)
        box.addView(
            line(
                if (lastSeen > 0) str(R.string.habitat_phone_seen, stamp.format(Date(lastSeen)))
                else str(R.string.habitat_phone_never)
            )
        )
        val commands = phone.optJSONArray("commands")
        if (commands != null && commands.length() > 0) {
            for (index in 0 until minOf(commands.length(), 3)) {
                val command = commands.optJSONObject(index) ?: continue
                val status = command.optString("status")
                box.addView(
                    line(
                        "▸ " + command.optString("action") +
                            (if (command.optString("arg").isNotBlank()) " " + command.optString("arg") else "") +
                            " · " + status.uppercase(Locale.US),
                        statusColor(status)
                    )
                )
                val output = command.optString("output")
                if (output.isNotBlank()) box.addView(line("   " + trim(output, 70)))
            }
            box.addView(line(str(R.string.habitat_phone_queued_note), color(R.color.text_dim)))
        } else {
            box.addView(line(str(R.string.habitat_phone_no_commands)))
        }
        buildPhoneActions()
    }

    private fun buildPhoneActions() {
        binding.habitatActions.visibility = View.VISIBLE
        binding.habitatActions.addView(
            action(str(R.string.habitat_action_status)) { send("status", "") }
        )
        binding.habitatActions.addView(
            action(str(R.string.habitat_action_home)) { send("page", "home") }
        )
        binding.habitatActions.addView(
            action(str(R.string.habitat_action_torch)) { send("torch", "on") }
        )
        binding.habitatActions.addView(
            action(str(R.string.habitat_action_torch_off)) { send("torch", "off") }
        )
    }

    private fun send(actionName: String, arg: String) {
        flash(str(R.string.habitat_queueing), soft = true)
        Thread {
            val outcome = runCatching { HabitatClient.sendPhoneAction(context, actionName, arg) }
            handler.post {
                outcome.onSuccess {
                    flash(str(R.string.habitat_queued, actionName), soft = true)
                    refresh()
                }.onFailure { flash(it.message ?: str(R.string.habitat_unreachable), soft = false) }
            }
        }.start()
    }

    private fun renderWorkers(data: JSONObject, box: LinearLayout) {
        val workers = data.optJSONObject("workers") ?: return
        box.addView(
            line(
                "PENDING " + workers.optInt("pendingTasks", 0) + "   WORKING " + workers.optInt("workingTasks", 0)
            )
        )
        val items = workers.optJSONArray("items")
        if (items != null) {
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index) ?: continue
                val state = item.optString("state")
                box.addView(line("▸ " + item.optString("name") + " · " + state.uppercase(Locale.US), statusColor(state)))
            }
        }
    }

    private fun renderBusiness(data: JSONObject, box: LinearLayout) {
        val business = data.optJSONObject("business")
        if (business == null || !business.optBoolean("available", false)) {
            box.addView(line(str(R.string.habitat_business_none), color(R.color.violet)))
            box.addView(line(business?.optString("reason").orEmpty()))
            box.addView(line(str(R.string.habitat_business_note)))
            return
        }
        box.addView(line(str(R.string.habitat_business_live)))
    }

    private fun renderFiles(data: JSONObject, box: LinearLayout) {
        val files = data.optJSONObject("files") ?: return
        val items = files.optJSONArray("items")
        box.addView(line(str(R.string.habitat_file_count, files.optInt("count", 0))))
        if (items == null || items.length() == 0) {
            box.addView(line(str(R.string.habitat_no_files)))
            return
        }
        for (index in 0 until minOf(items.length(), 5)) {
            val file = items.optJSONObject(index) ?: continue
            val name = file.optString("name")
            box.addView(
                line("▸ " + trim(name, 46) + " · " + file.optInt("size", 0) + " B", color(R.color.cyan)).apply {
                    setOnClickListener { openFile(name) }
                }
            )
        }
        box.addView(line(str(R.string.habitat_file_tap)))
    }

    private fun openFile(name: String) {
        Thread {
            val outcome = runCatching { HabitatClient.readFile(context, name) }
            handler.post {
                outcome.onSuccess { file ->
                    val body = file.optString("data")
                    android.app.AlertDialog.Builder(context)
                        .setTitle(trim(name, 40))
                        .setMessage(trim(body, 1400).ifBlank { str(R.string.habitat_file_binary) })
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }.onFailure { flash(it.message ?: str(R.string.habitat_unreachable), soft = false) }
            }
        }.start()
    }

    private fun renderCloud(data: JSONObject, box: LinearLayout) {
        val cloud = data.optJSONObject("cloud") ?: return
        val relay = data.optJSONObject("relay")
        box.addView(
            line(
                str(R.string.habitat_relay) + " " +
                    (relay?.optString("health")?.uppercase(Locale.US) ?: "UNKNOWN"),
                if (relay?.optString("health") == "ok") color(R.color.cyan) else color(R.color.text_dim)
            )
        )
        val habitat = cloud.optJSONObject("habitat")
        box.addView(line(str(R.string.habitat_backend) + " " + habitat?.optString("status").orEmpty().uppercase(Locale.US)))
        box.addView(
            line(
                str(R.string.habitat_providers) + " " +
                    (if (cloud.optJSONObject("providers")?.optBoolean("openRouter") == true) "OPENROUTER" else "OPENROUTER OFF") +
                    " · " + (if (cloud.optJSONObject("providers")?.optBoolean("relay") == true) "RELAY" else "RELAY OFF")
            )
        )
        box.addView(
            line(
                str(R.string.habitat_notify) + " " +
                    str(if (HabitatNotifier.enabled(context)) R.string.habitat_notify_on else R.string.habitat_notify_blocked),
                if (HabitatNotifier.enabled(context)) color(R.color.cyan) else color(R.color.text_dim)
            )
        )
        val github = cloud.optJSONObject("github")
        if (github != null && github.optBoolean("ok", false)) {
            box.addView(line(trim(github.optString("repo"), 46), color(R.color.violet)))
            val commits = github.optJSONArray("commits")
            if (commits != null) {
                for (index in 0 until minOf(commits.length(), 3)) {
                    val commit = commits.optJSONObject(index) ?: continue
                    box.addView(line("▸ " + commit.optString("short") + " " + trim(commit.optString("message"), 52)))
                }
            }
        } else {
            box.addView(line(str(R.string.habitat_github_off) + (github?.optString("error").orEmpty())))
        }
    }

    // ---- small helpers -----------------------------------------------------

    private fun line(text: String, textColor: Int = color(R.color.text_soft)): TextView =
        TextView(context).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 9f)
            typeface = Typeface.MONOSPACE
            letterSpacing = 0.06f
            setTextColor(textColor)
            setPadding(0, dp(2), 0, dp(2))
        }

    private fun action(label: String, onTap: () -> Unit): TextView =
        TextView(context).apply {
            text = label
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 8f)
            typeface = Typeface.MONOSPACE
            letterSpacing = 0.1f
            setTextColor(color(R.color.cyan))
            background = ContextCompat.getDrawable(context, R.drawable.bg_habitat_chip)
            setPadding(dp(9), dp(5), dp(9), dp(5))
            isClickable = true
            isFocusable = true
            setOnClickListener { onTap() }
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.marginEnd = dp(5)
            layoutParams = params
        }

    private fun flash(message: String, soft: Boolean) {
        binding.habitatError.visibility = View.VISIBLE
        binding.habitatError.text = message
        binding.habitatError.setTextColor(color(if (soft) R.color.cyan else R.color.text_dim))
    }

    private fun statusColor(status: String): Int = when (status.lowercase(Locale.US)) {
        "done", "active", "online", "polling", "serving", "completed" -> color(R.color.cyan)
        "working", "taken", "assigned", "queued" -> color(R.color.violet)
        "failed", "error", "offline", "unreachable" -> color(R.color.text_dim)
        else -> color(R.color.text_soft)
    }

    private fun shortId(): String = HabitatClient.deviceId(context).takeLast(8)

    private fun trim(value: String, max: Int): String =
        if (value.length <= max) value else value.take(max - 1) + "…"

    private fun str(id: Int): String = context.getString(id)

    private fun str(id: Int, vararg args: Any): String = context.getString(id, *args)

    private fun color(id: Int): Int = ContextCompat.getColor(context, id)

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val REFRESH_MS = 90_000L
    }
}
