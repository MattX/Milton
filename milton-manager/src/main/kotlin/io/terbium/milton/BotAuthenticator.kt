package io.terbium.milton

import javax.inject.Inject

open class BotAuthenticator @Inject constructor(@BotSecrets private val botSecrets: Map<String, String>) {
    fun authenticate(botName: String, botSecret: String): Boolean {
        return botSecrets[botName] == botSecret
    }
}
