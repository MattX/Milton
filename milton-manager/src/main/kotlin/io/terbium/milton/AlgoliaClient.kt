package io.terbium.milton

import com.algolia.search.client.ClientSearch
import com.algolia.search.model.APIKey
import com.algolia.search.model.ApplicationID
import com.algolia.search.model.IndexName
import com.algolia.search.model.ObjectID
import kotlinx.serialization.json.json
import java.security.MessageDigest
import java.util.*

class AlgoliaClient(algoliaAccount: String, algoliaSecret: String) {
    private val client = ClientSearch(ApplicationID(algoliaAccount), APIKey(algoliaSecret))
    private val indexName = IndexName("posts")
    private val index = client.initIndex(indexName)
    private val maxRecordSize = 2 * 1024
    private val chunker = StringChunker(maxRecordSize)

    suspend fun indexPage(url: String, title: String, siteName: String?, storageId: String, content: String): Int {
        val objects = chunker.chunkString(content).mapIndexed { idx, part ->
            json {
                "objectId" to ObjectID("${sha256(url)}:$idx")
                "title" to title
                "siteName" to siteName
                "text" to part
                "url" to url
                "storageId" to storageId
            }
        }

        index.saveObjects(objects)

        return objects.size
    }

    private val shaDigest = MessageDigest.getInstance("SHA-256")
    private val b64enc = Base64.getEncoder()

    private fun sha256(s: String): String =
        b64enc.encodeToString(shaDigest.digest(s.toByteArray(Charsets.UTF_8)))

    private data class AlgoliaRecord(
            val identifier: String,
            val title: String,
            val siteName: String?,
            val text: String,
            val url: String,
            val storageId: String
    )
}