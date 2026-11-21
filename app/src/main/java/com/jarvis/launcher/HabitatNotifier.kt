package com.jarvis.launcher

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Local completion notifications for the Habitat panel.
 *
 * These are delivered from the same payload the panel already fetches, so they work while the
 * launcher is running or in the background with its process alive, and they catch up on the next
 * sync after the phone was offline. They are NOT push notifications: nothing arrives while the
 * launcher process is dead. Real push needs a Firebase project and a server key, which is an owner
 * side setup step rather than something this app can invent.
 *
 * Nothing is reported unless Habitat itself reported a terminal status, so a queued command never
 * produces a "finished" notification.
 */
object HabitatNotifier {

    private const val CHANNEL = "habitat_status"
    private const val PREFS = "launcher_state"
    private const val KEY_SINCE = "habitat_notified_since"
    private const val REQUEST_CODE = 0x4842

    /** True only when the system will actually show a notification. */
    fun enabled(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** Asked from the launcher itself once, so no MainActivity change is needed. */
    fun ensurePermission(context: Context) {
        if (Build.VERSION.SDK_INT < 33) return
        val activity = context as? Activity ?: return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) return
        runCatching {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_CODE
            )
        }
    }

    /**
     * Posts one notification per newly finished item and moves the baseline forward. The baseline is
     * the previous successful sync, so events that happened while the phone was away are delivered
     * on reconnection exactly once.
     */
    fun onSync(context: Context, payload: JSONObject) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getLong(KEY_SINCE, 0L)
        val events = HabitatEvents.since(payload, since)
        if (events.isNotEmpty() && enabled(context)) {
            createChannel(context)
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pending = launch?.let {
                PendingIntent.getActivity(
                    context,
                    0,
                    it,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            }
            for (event in events.take(3)) {
                val notification = NotificationCompat.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setContentTitle(event.title)
                    .setContentText(event.body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(event.body))
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setAutoCancel(true)
                    .apply { if (pending != null) setContentIntent(pending) }
                    .build()
                runCatching {
                    NotificationManagerCompat.from(context).notify(event.key.hashCode(), notification)
                }
            }
        }
        prefs.edit().putLong(KEY_SINCE, System.currentTimeMillis()).apply()
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL,
                context.getString(R.string.habitat_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = context.getString(R.string.habitat_channel_desc)
                setShowBadge(true)
            }
        )
    }
}
