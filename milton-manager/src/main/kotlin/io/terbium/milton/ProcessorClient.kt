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

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.features.HttpTimeout
import io.ktor.client.features.json.GsonSerializer
import io.ktor.client.features.json.JsonFeature
import io.ktor.client.request.post
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ProcessorClient @Inject constructor(@ProcessorHost processorHost: String) {
    private val processorUrl = "$processorHost/extract"
    private val json = io.ktor.client.features.json.defaultSerializer()
    private val httpClient = HttpClient(OkHttp) {
        install(JsonFeature) {
            serializer = GsonSerializer {
                serializeNulls()
            }
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 15_000
            socketTimeoutMillis = 15_000
        }
    }

    suspend fun process(content: String): ProcessedPage {
        return httpClient.post<ProcessorOutput>(processorUrl) {
            body = json.write(ProcessorInput(content))
        }.toProcessedPage()
    }

    private data class ProcessorInput(
        val page: String
    )

    private data class ProcessorOutput(
        val title: String,
        val byline: String?,
        val dir: String?,
        val content: String,
        val textContent: String,
        val length: Long,
        val siteName: String?
    ) {
        fun toProcessedPage() = ProcessedPage(
                title = title,
                byline = byline,
                content = content,
                textContent = textContent,
                siteName = siteName
        )
    }

    data class ProcessedPage(
            val title: String,
            val byline: String?,
            val content: String,
            val textContent: String,
            val siteName: String?
    )
}
