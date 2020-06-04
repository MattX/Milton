package io.terbium.milton

import io.ktor.application.call
import io.ktor.auth.Authentication
import io.ktor.auth.AuthenticationPipeline
import io.ktor.auth.AuthenticationProvider
import io.ktor.auth.Principal
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.response.respond
import org.slf4j.LoggerFactory

class MiltonAuthenticationProvider internal constructor(config: Configuration) : AuthenticationProvider(config) {
    private val googleAuthenticator: GoogleAuthenticator = config.googleAuthenticator
    private val botAuthenticator: BotAuthenticator = config.botAuthenticator

    class Configuration internal constructor(name: String?) : AuthenticationProvider.Configuration(name) {
        lateinit var googleAuthenticator: GoogleAuthenticator
        lateinit var botAuthenticator: BotAuthenticator
    }

    fun authenticateBot(botName: String, botSecret: String): Boolean = botAuthenticator.authenticate(botName, botSecret)

    fun authenticateUser(token: String): Boolean = googleAuthenticator.authenticate(token)
}

fun Authentication.Configuration.miltonAuthentication(
        name: String? = null,
        configure: MiltonAuthenticationProvider.Configuration.() -> Unit
) {
    val provider = MiltonAuthenticationProvider(MiltonAuthenticationProvider.Configuration(name).apply(configure))
    provider.pipeline.intercept(AuthenticationPipeline.RequestAuthentication) { context ->
        val authenticationString = call.request.headers[HttpHeaders.Authorization]
        if (authenticationString == null) {
            return@intercept call.respond(HttpStatusCode.Forbidden, "no auth header")
        }

        logger.info("Auth header: $authenticationString")
        val (mode, token) = authenticationString.split(Regex("\\s+"), limit = 2)
        if (mode.toLowerCase() != "bearer") {
            return@intercept call.respond(HttpStatusCode.Forbidden, "invalid auth mode")
        }
        val (type, tok) = token.split(";", limit = 2)
        when (type) {
            "bot" -> {
                val (botName, botSecret) = tok.split(";", limit = 2)
                val ok = provider.authenticateBot(botName, botSecret)
                if (ok) {
                    context.principal(BotPrincipal)
                } else {
                    call.respond(HttpStatusCode.Forbidden, "authentication failed")
                }
            }
            "google" -> {
                logger.info(tok)
                val ok = provider.authenticateUser(tok)
                if (ok) {
                    context.principal(UserPrincipal)
                } else {
                    call.respond(HttpStatusCode.Forbidden, "authentication failed")
                }
            }
        }
    }
    register(provider)
}

val logger = LoggerFactory.getLogger(MiltonAuthenticationProvider::class.java)

sealed class MiltonPrincipal : Principal

object BotPrincipal : MiltonPrincipal()
object UserPrincipal : MiltonPrincipal()
