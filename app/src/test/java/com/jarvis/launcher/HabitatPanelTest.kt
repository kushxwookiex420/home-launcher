package com.jarvis.launcher

import android.content.Context
import android.view.View
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Habitat panel has to survive the two states it is always in: unlinked and collapsed.
 * Neither may touch the network, and both have to show an honest status line.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class HabitatPanelTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @After
    fun clean() {
        HabitatClient.unlink(context)
        context.getSharedPreferences("launcher_state", Context.MODE_PRIVATE).edit()
            .remove("habitat_expanded")
            .remove("habitat_device_id")
            .apply()
    }

    @Test
    fun panelStartsCollapsedWithEverySectionTab() {
        val panel = HabitatDashboardView(context)
        assertEquals(View.GONE, panel.findViewById<View>(R.id.habitatBody).visibility)
        val tabs = panel.findViewById<android.widget.LinearLayout>(R.id.habitatTabs)
        assertEquals(7, tabs.childCount)
    }

    @Test
    fun unlinkedPanelOffersThePairingFieldAndSaysSo() {
        val panel = HabitatDashboardView(context)
        panel.findViewById<View>(R.id.habitatHeader).performClick()
        assertEquals(View.VISIBLE, panel.findViewById<View>(R.id.habitatBody).visibility)
        assertEquals(View.VISIBLE, panel.findViewById<View>(R.id.habitatLinkRow).visibility)
        val sync = panel.findViewById<android.widget.TextView>(R.id.habitatSync).text.toString()
        assertTrue(sync.contains("NOT LINKED"))
        assertTrue(sync.contains("ID "))
    }

    @Test
    fun linkingWithoutACodeDoesNotClaimSuccess() {
        val panel = HabitatDashboardView(context)
        panel.findViewById<View>(R.id.habitatHeader).performClick()
        panel.findViewById<View>(R.id.habitatLink).performClick()
        val message = panel.findViewById<android.widget.TextView>(R.id.habitatError)
        assertEquals(View.VISIBLE, message.visibility)
        assertTrue(message.text.toString().lowercase().contains("pairing code"))
        assertTrue(!HabitatClient.isLinked(context))
    }

    @Test
    fun deviceIdIsStableAcrossCallsAndPrefixed() {
        val first = HabitatClient.deviceId(context)
        val second = HabitatClient.deviceId(context)
        assertEquals(first, second)
        assertTrue(first.startsWith("launcher-"))
    }

    @Test
    fun baseUrlDefaultsToTheHabitatHostAndRejectsNonsense() {
        assertEquals(HabitatClient.DEFAULT_BASE, HabitatClient.base(context))
        HabitatClient.setBase(context, "not a url")
        assertEquals(HabitatClient.DEFAULT_BASE, HabitatClient.base(context))
        HabitatClient.setBase(context, "https://habitat-1-szzd.onrender.com/")
        assertEquals("https://habitat-1-szzd.onrender.com", HabitatClient.base(context))
    }
}
