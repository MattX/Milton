/*
 * Copyright 2020 The Milton Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package io.terbium.milton

import com.google.inject.Guice
import io.ktor.application.Application
import io.ktor.application.call
import io.ktor.application.install
import io.ktor.application.log
import io.ktor.auth.Authentication
import io.ktor.auth.authenticate
import io.ktor.auth.authentication
import io.ktor.features.CORS
import io.ktor.features.CallLogging
import io.ktor.features.ContentNegotiation
import io.ktor.features.DefaultHeaders
import io.ktor.gson.gson
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.response.respond
import io.ktor.routing.get
import io.ktor.routing.post
import io.ktor.routing.routing
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.MalformedURLException
import java.net.URL
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.Result.Companion.failure
import kotlin.Result.Companion.success

@Singleton
class Milton @Inject constructor(
        private val algoliaClient: AlgoliaClient,
        private val pageManager: PageManager,
        // private val botAuthenticator: BotAuthenticator,
        private val googleAuthenticator: GoogleAuthenticator
) {
    fun Application.setup() {
        install(Authentication) {
            miltonAuthentication {
                //botAuthenticator = this@Milton.botAuthenticator
                botAuthenticator = object : BotAuthenticator(mapOf()) {}
                googleAuthenticator = this@Milton.googleAuthenticator
            }
        }
        install(DefaultHeaders)
        install(CallLogging)
        install(ContentNegotiation) {
            gson {
                serializeNulls()
            }
        }
        install(CORS) {
            anyHost()
            header(HttpHeaders.Authorization)
        }

        routing {
            get("/") {
                call.respond("Hello! If you are seeing this, your static files aren't being served correctly.")
            }
            get("/list") {
                call.respond(pageManager.list())
            }
            get("/content") {
                val storageId = call.request.queryParameters["id"]
                        ?: return@get call.response.status(HttpStatusCode.BadRequest)
                call.respond(TextContent(pageManager.getContent(storageId), ContentType.Text.Html))
            }
            get("/search") {
                val searchQuery = call.request.queryParameters["q"]
                        ?: return@get call.response.status(HttpStatusCode.BadRequest)
                call.respond(algoliaClient.search(searchQuery))
            }

            authenticate {
                post("/save") {
                    if (call.authentication.principal == null) {
                        log.warn("unauthenticated save request!")
                    }
                    val urlString = call.request.queryParameters["url"]
                            ?: return@post call.response.status(HttpStatusCode.BadRequest)
                    val parsedUrl = withContext(Dispatchers.IO) {
                        try {
                            success(URL(urlString))
                        } catch (e: MalformedURLException) {
                            failure<URL>(e)
                        }
                    }
                    if (parsedUrl.isFailure)
                        return@post call.respond(HttpStatusCode.BadRequest, "invalid url: $urlString")
                    val url = parsedUrl.getOrNull()!!
                    when (val result = pageManager.register(url)) {
                        is PageManager.RegisterResult.Unsupported ->
                            call.respond(HttpStatusCode.UnprocessableEntity,
                                    "can't process page at $urlString: ${result.cause}")
                        is PageManager.RegisterResult.FetchError ->
                            call.respond(HttpStatusCode.UnprocessableEntity,
                                    "can't fetch page at $urlString: ${result.cause}")
                        is PageManager.RegisterResult.Success -> call.respond(result.entry)
                    }
                }
                get("/testAuth") {
                    if (call.authentication.principal == null) {
                        call.respond(HttpStatusCode.Forbidden, "authentication failed.")
                    } else {
                        call.respond("all good!")
                    }
                }
            }
        }
    }
}

fun Application.miltonManager() {
    val milton = Guice.createInjector(MiltonManagerModule()).getInstance(Milton::class.java)!!
    with (milton) {
        setup()
    }
}

fun main() {
    val milton = Guice.createInjector(MiltonManagerModule()).getInstance(Milton::class.java)!!
    val server = embeddedServer(Netty, 8080) {
        with (milton) {
            setup()
        }
    }
    server.start(wait = true)
}
