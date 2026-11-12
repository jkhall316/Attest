package com.attest.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The server address and the Access service token. The secret is encrypted with a key that lives in
 * the Android Keystore (it never leaves the phone's secure hardware where there is one), so it is
 * never in preferences in the clear or in logs. Cloud backup and phone-to-phone transfer are off
 * (allowBackup, res/xml/data_extraction_rules.xml), and the key could not move anyway.
 */
object Store {
    private const val PREFS = "attest"
    private const val KEY_ALIAS = "attest-token"

    fun load(context: Context): ServerConfig? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val server = p.getString("server", null) ?: return null
        val stored = p.getString("secret", null)
        val secret = stored?.let { decrypt(it) }
        // The key is gone (phone restored or moved, screen lock removed): drop the whole token rather than
        // send an ID with an empty secret. Uploads fall back to the app's sign-in; the person re-enters it.
        if (stored != null && secret == null) return ServerConfig(server)
        return ServerConfig(server, p.getString("client_id", "").orEmpty(), secret.orEmpty())
    }

    fun save(context: Context, config: ServerConfig) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("server", config.server)
            .putString("client_id", config.clientId)
            .putString("secret", if (config.clientSecret.isEmpty()) null else encrypt(config.clientSecret))
            .apply()
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    // Null if the key is gone (e.g. the screen lock was removed on some phones): the person re-enters it.
    private fun decrypt(stored: String): String? = try {
        val all = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all, 0, 12))
        String(c.doFinal(all, 12, all.size - 12), Charsets.UTF_8)
    } catch (e: Exception) { null }
}
